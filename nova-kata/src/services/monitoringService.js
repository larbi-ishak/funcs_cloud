const cron = require('node-cron');
const axios = require('axios');
const http = require('http');
const { workers, containers, warmPool, functions } = require('../db/database');
const { checkWorkerHealth } = require('./workerService');
const logger = require('../utils/logger');

let task = null;

const WORKER_API_KEY = process.env.WORKER_API_KEY || 'nova-worker-default-key';
const WORKER_API_PORT = parseInt(process.env.WORKER_API_PORT) || 3005;
const workerApiClient = axios.create({
    httpAgent: new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 10 }),
    timeout: 10000,
    headers: { 'X-Worker-Key': WORKER_API_KEY },
});

function startMonitoring() {
    const intervalMs = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS) || 30000;
    const intervalSec = Math.max(5, Math.floor(intervalMs / 1000));
    const cronExpression =
        intervalSec < 60 ? `*/${intervalSec} * * * * *` : `0 */${Math.floor(intervalSec / 60)} * * * *`;
    logger.info(`Monitoring started (interval: ${intervalSec}s, cron: "${cronExpression}")`);
    task = cron.schedule(cronExpression, async () => {
        await runHealthCheckCycle();
    });
}

function stopMonitoring() {
    if (task) { task.stop(); logger.info('Monitoring stopped'); }
}

async function runHealthCheckCycle() {
    const allWorkers = (await workers.findAll()).filter((w) => w.status !== 'retired');
    if (allWorkers.length === 0) return;
    logger.debug(`Health check cycle: ${allWorkers.length} worker(s) to check`);
    const results = await Promise.allSettled(
        allWorkers.map((w) => checkWorkerHealth(w.id).catch((err) => ({ healthy: false, reason: err.message })))
    );
    const healthy = results.filter((r) => r.status === 'fulfilled' && r.value.healthy).length;
    const unhealthy = allWorkers.length - healthy;
    if (unhealthy > 0) logger.warn(`Health check: ${healthy}/${allWorkers.length} healthy, ${unhealthy} unhealthy`);
    else logger.debug(`Health check: all ${healthy} workers healthy`);

    if (process.env.RECONCILIATION_ENABLED !== 'false') {
        const healthyWorkers = allWorkers.filter((w, i) => results[i].status === 'fulfilled' && results[i].value.healthy);
        for (const worker of healthyWorkers) {
            try {
                const reconciled = await reconcileWorkerContainers(worker);
                if (reconciled > 0) logger.info(`[Reconcile] ${reconciled} container(s) reconciled on worker ${worker.ip}`);
            } catch (err) { logger.warn(`[Reconcile] Failed for worker ${worker.ip}: ${err.message}`); }
        }
    }
    await cleanOrphans();
    await cleanStaleContainers();

    if (process.env.GCP_PROJECT_ID) {
        try {
            const { checkAndScale } = require('./scalingService');
            const result = await checkAndScale();
            if (result.triggered) logger.info(`[AutoScale] Scale-out triggered — ${result.reason}`);
            else logger.debug(`[AutoScale] No action — ${result.reason}`);
        } catch (err) { logger.error(`[AutoScale] checkAndScale error: ${err.message}`); }
    }
}

async function cleanOrphans() {
    const allWorkers = await workers.findAll();
    const workerIds = new Set(allWorkers.map(w => w.id));
    const retiredOnly = allWorkers.filter(w => w.status === 'retired');
    for (const w of retiredOnly) {
        const warmEntries = await warmPool.findAll();
        const before = warmEntries.filter(e => e.worker_id === w.id).length;
        if (before > 0) {
            await warmPool.removeByWorkerId(w.id);
            logger.info(`[OrphanCleanup] Removed ${before} warm pool entries for retired worker ${w.id}`);
        }
    }
    const allContainers = await containers.findAll();
    for (const c of allContainers) {
        if (c.status === 'stopped' || c.status === 'failed') continue;
        const worker = allWorkers.find(w => w.id === c.worker_id);
        if (worker && worker.status === 'retired') {
            await containers.updateStatus(c.id, 'failed');
            await warmPool.deleteByContainer(c.id);
            logger.info(`[OrphanCleanup] Marked container ${c.container_name} as failed (worker retired)`);
        }
        if (!workerIds.has(c.worker_id)) {
            await containers.updateStatus(c.id, 'failed');
            await warmPool.deleteByContainer(c.id);
            logger.warn(`[OrphanCleanup] Marked container ${c.container_name} as failed (worker ${c.worker_id} deleted)`);
        }
    }
    const allWarm = await warmPool.findAll();
    for (const entry of allWarm) {
        if (!workerIds.has(entry.worker_id)) {
            await warmPool.deleteByContainer(entry.container_id);
            logger.warn(`[OrphanCleanup] Removed warm pool entry for deleted worker ${entry.worker_id}`);
        }
    }
}

async function cleanStaleContainers() {
    const STALE_THRESHOLD_MS = parseInt(process.env.STALE_CONTAINER_THRESHOLD_MS) || 600000;
    const now = Date.now();
    const allContainers = await containers.findAll();
    for (const c of allContainers) {
        if (c.status === 'creating') {
            if (!c.started_at) {
                logger.warn(`[StaleCleanup] Container ${c.container_name} has no started_at — setting to now`);
                await containers.updateStatus(c.id, 'creating', { started_at: new Date().toISOString() });
                continue;
            }
            const created = new Date(c.started_at).getTime();
            const elapsedMs = now - created;
            if (elapsedMs > STALE_THRESHOLD_MS) {
                await containers.updateStatus(c.id, 'failed');
                await warmPool.deleteByContainer(c.id);
                logger.warn(`[StaleCleanup] Container ${c.container_name} stuck in 'creating' for ${Math.round(elapsedMs / 60000)}min (> ${Math.round(STALE_THRESHOLD_MS / 60000)}min threshold) → marked failed`);
            }
        }
    }
}

async function reconcileWorkerContainers(worker) {
    const { data } = await workerApiClient.get(`http://${worker.ip}:${WORKER_API_PORT}/ps`);
    const actualMap = new Map();
    for (const c of (data.containers || [])) actualMap.set(c.name, c.status);
    const expected = await containers.findByWorker(worker.id);
    let reconciled = 0;
    const dbContainerNames = new Set(expected.map(c => c.container_name));
    for (const c of expected) {
        if (c.status === 'creating') continue;
        const actualStatus = actualMap.get(c.container_name);
        if (!actualStatus) {
            logger.warn(`[Reconcile] ${c.container_name} in DB (${c.status}) but missing on worker → failed`);
            await containers.updateStatus(c.id, 'failed');
            await warmPool.deleteByContainer(c.id);
            reconciled++;
        } else if (actualStatus.startsWith('Exited') || actualStatus === 'Dead') {
            logger.warn(`[Reconcile] ${c.container_name} exited on worker but DB says ${c.status} → failed, removing`);
            await containers.updateStatus(c.id, 'failed');
            await warmPool.deleteByContainer(c.id);
            try { await workerApiClient.post(`http://${worker.ip}:${WORKER_API_PORT}/stop`, { container_name: c.container_name }); }
            catch (stopErr) { logger.warn(`[Reconcile] Failed to remove dead container ${c.container_name}: ${stopErr.message}`); }
            reconciled++;
        } else if (actualStatus.startsWith('Up') && c.status === 'paused') {
            logger.info(`[Reconcile] ${c.container_name} running on worker but DB says paused → running`);
            await containers.updateStatus(c.id, 'running');
            reconciled++;
        } else if (actualStatus.startsWith('Paused') && c.status === 'running') {
            logger.info(`[Reconcile] ${c.container_name} paused on worker but DB says running → paused`);
            await containers.updateStatus(c.id, 'paused');
            reconciled++;
        }
    }
    for (const [name, status] of actualMap) {
        if (!name.startsWith('nova-')) continue;
        if (dbContainerNames.has(name)) continue;
        logger.warn(`[Reconcile] Orphaned container ${name} (${status}) on worker ${worker.ip} — removing`);
        try { await workerApiClient.post(`http://${worker.ip}:${WORKER_API_PORT}/stop`, { container_name: name }); reconciled++; }
        catch (stopErr) { logger.warn(`[Reconcile] Failed to remove orphaned container ${name}: ${stopErr.message}`); }
    }
    return reconciled;
}

async function invalidateGatewayCache(functionName) {
    const gatewayUrl = process.env.GATEWAY_URL;
    if (!gatewayUrl) return;
    const http = require('http');
    const url = new URL('/internal/invalidate', gatewayUrl);
    const invalidate = async (body) => {
        await new Promise((resolve, reject) => {
            const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 5000 }, (res) => {
                res.resume(); if (res.statusCode >= 200 && res.statusCode < 300) resolve(); else reject(new Error(`Gateway returned ${res.statusCode}`));
            });
            req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            req.write(JSON.stringify(body)); req.end();
        });
    };
    try { await invalidate({ prefix: 'ct:' }); logger.info('[GatewayCache] Invalidated container cache (ct:) on gateway'); }
    catch (err) { logger.debug(`[GatewayCache] Container cache invalidation failed: ${err.message}`); }
    try {
        if (functionName) { await invalidate({ key: `fn:${functionName}` }); logger.info(`[GatewayCache] Invalidated function cache (fn:${functionName}) on gateway`); }
        else { await invalidate({ prefix: 'fn:' }); logger.info('[GatewayCache] Invalidated all function cache (fn:) on gateway'); }
    } catch (err) { logger.debug(`[GatewayCache] Function cache invalidation failed: ${err.message}`); }
}

module.exports = { startMonitoring, stopMonitoring, runHealthCheckCycle, invalidateGatewayCache };