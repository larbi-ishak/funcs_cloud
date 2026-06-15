const cron = require('node-cron');
const axios = require('axios');
const http = require('http');
const { workers, containers, warmPool, functions } = require('../db/database');
const { checkWorkerHealth } = require('./workerService');
const logger = require('../utils/logger');

let task = null;

// ── Worker API client for reconciliation ────────────────────────────────────
const WORKER_API_KEY = process.env.WORKER_API_KEY || 'nova-worker-default-key';
const WORKER_API_PORT = parseInt(process.env.WORKER_API_PORT) || 3005;
const workerApiClient = axios.create({
    httpAgent: new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 10 }),
    timeout: 10000,
    headers: { 'X-Worker-Key': WORKER_API_KEY },
});

/**
 * Start the background monitoring loop.
 */
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
    if (task) {
        task.stop();
        logger.info('Monitoring stopped');
    }
}

async function runHealthCheckCycle() {
    // Check all non-retired workers (including faulty — they're in grace period)
    const allWorkers = workers
        .findAll()
        .filter((w) => w.status !== 'retired');

    if (allWorkers.length === 0) return;

    logger.debug(`Health check cycle: ${allWorkers.length} worker(s) to check`);

    const results = await Promise.allSettled(
        allWorkers.map((w) =>
            checkWorkerHealth(w.id).catch((err) => ({
                healthy: false,
                reason: err.message,
            }))
        )
    );

    const healthy = results.filter(
        (r) => r.status === 'fulfilled' && r.value.healthy
    ).length;
    const unhealthy = allWorkers.length - healthy;

    if (unhealthy > 0) {
        logger.warn(`Health check: ${healthy}/${allWorkers.length} healthy, ${unhealthy} unhealthy`);
    } else {
        logger.debug(`Health check: all ${healthy} workers healthy`);
    }

    // ── Reconciliation Loop ──────────────────────────────────────────────────
    // Compare DB state vs actual worker state for healthy workers.
    // Feature-flagged: set RECONCILIATION_ENABLED=false to disable.
    if (process.env.RECONCILIATION_ENABLED !== 'false') {
        const healthyWorkers = allWorkers.filter((w, i) =>
            results[i].status === 'fulfilled' && results[i].value.healthy
        );
        for (const worker of healthyWorkers) {
            try {
                const reconciled = await reconcileWorkerContainers(worker);
                if (reconciled > 0) {
                    logger.info(`[Reconcile] ${reconciled} container(s) reconciled on worker ${worker.ip}`);
                }
            } catch (err) {
                logger.warn(`[Reconcile] Failed for worker ${worker.ip}: ${err.message}`);
            }
        }
    }

    // ── Orphan + Stale Cleanup ──────────────────────────────────────────────
    cleanOrphans();
    cleanStaleContainers();

    // ── Auto-scaling check ────────────────────────────────────────────────────
    // Skipped silently if GCP_PROJECT_ID is not set (GCP not configured).
    if (process.env.GCP_PROJECT_ID) {
        try {
            const { checkAndScale } = require('./scalingService');
            const result = await checkAndScale();
            if (result.triggered) {
                logger.info(`[AutoScale] Scale-out triggered — ${result.reason}`);
            } else {
                logger.debug(`[AutoScale] No action — ${result.reason}`);
            }
        } catch (err) {
            logger.error(`[AutoScale] checkAndScale error: ${err.message}`);
        }
    }
}

// ─── Orphan Cleanup ──────────────────────────────────────────────────────────
/**
 * Clean up DB records that reference deleted/faulty/retired workers.
 * Runs every health check cycle.
 */
function cleanOrphans() {
    const allWorkers = workers.findAll();
    const workerIds = new Set(allWorkers.map(w => w.id));
    // Only orphan containers for RETIRED workers (faulty workers are in grace period)
    const retiredOnly = allWorkers.filter(w => w.status === 'retired');

    // 1. Clean warm pool entries for retired workers
    for (const w of retiredOnly) {
        const before = warmPool.findAll().filter(e => e.worker_id === w.id).length;
        if (before > 0) {
            warmPool.removeByWorkerId(w.id);
            logger.info(`[OrphanCleanup] Removed ${before} warm pool entries for retired worker ${w.id}`);
        }
    }

    // 2. Mark containers as 'failed' for retired workers only
    const allContainers = containers.findAll();
    for (const c of allContainers) {
        if (c.status === 'stopped' || c.status === 'failed') continue;

        // Container's worker is retired
        const worker = allWorkers.find(w => w.id === c.worker_id);
        if (worker && worker.status === 'retired') {
            containers.updateStatus(c.id, 'failed');
            warmPool.deleteByContainer(c.id);
            logger.info(`[OrphanCleanup] Marked container ${c.container_name} as failed (worker retired)`);
        }

        // Container's worker was deleted entirely
        if (!workerIds.has(c.worker_id)) {
            containers.updateStatus(c.id, 'failed');
            warmPool.deleteByContainer(c.id);
            logger.warn(`[OrphanCleanup] Marked container ${c.container_name} as failed (worker ${c.worker_id} deleted)`);
        }
    }

    // 3. Clean warm pool entries for deleted workers
    const allWarm = warmPool.findAll();
    for (const entry of allWarm) {
        if (!workerIds.has(entry.worker_id)) {
            warmPool.deleteByContainer(entry.container_id);
            logger.warn(`[OrphanCleanup] Removed warm pool entry for deleted worker ${entry.worker_id}`);
        }
    }
}

// ─── Stale Container Cleanup ─────────────────────────────────────────────────
/**
 * Find containers stuck in transient states and mark them as failed.
 * Runs every health check cycle.
 */
function cleanStaleContainers() {
    const STALE_THRESHOLD_MS = parseInt(process.env.STALE_CONTAINER_THRESHOLD_MS) || 600000; // 10 minutes default
    const now = Date.now();

    const allContainers = containers.findAll();
    for (const c of allContainers) {
        // Containers stuck in 'creating' beyond threshold
        if (c.status === 'creating') {
            if (!c.started_at) {
                // Safety net: if started_at is missing, set it now so it can be checked next cycle
                logger.warn(`[StaleCleanup] Container ${c.container_name} has no started_at — setting to now`);
                containers.updateStatus(c.id, 'creating', { started_at: new Date().toISOString() });
                continue;
            }
            const created = new Date(c.started_at).getTime();
            const elapsedMs = now - created;
            if (elapsedMs > STALE_THRESHOLD_MS) {
                containers.updateStatus(c.id, 'failed');
                warmPool.deleteByContainer(c.id);
                logger.warn(`[StaleCleanup] Container ${c.container_name} stuck in 'creating' for ${Math.round(elapsedMs / 60000)}min (> ${Math.round(STALE_THRESHOLD_MS / 60000)}min threshold) → marked failed`);
            }
        }
    }
}

// ─── Reconciliation Loop ──────────────────────────────────────────────────────
/**
 * Compare DB state vs actual worker state and reconcile discrepancies.
 * Uses the Worker API (HTTP) for speed — falls back to SSH if unavailable.
 *
 * Detects:
 *  - Container in DB but missing on worker → mark failed
 *  - Container dead on worker but DB says alive → mark failed
 *  - Container running on worker but DB says paused → update DB
 *
 * @param {object} worker - worker DB record
 * @returns {number} count of reconciled containers
 */
async function reconcileWorkerContainers(worker) {
    // Call Worker API /ps to get actual container state
    const { data } = await workerApiClient.get(`http://${worker.ip}:${WORKER_API_PORT}/ps`);
    const actualMap = new Map();
    for (const c of (data.containers || [])) {
        actualMap.set(c.name, c.status);
    }

    // Get expected state from DB (all non-terminal containers for this worker)
    const expected = containers.findByWorker(worker.id);
    let reconciled = 0;

    for (const c of expected) {
        // Skip containers being launched — they won't be visible on worker yet
        if (c.status === 'creating') continue;

        const actualStatus = actualMap.get(c.container_name);

        if (!actualStatus) {
            // Container in DB but not on worker → mark failed
            logger.warn(`[Reconcile] ${c.container_name} in DB (${c.status}) but missing on worker → failed`);
            containers.updateStatus(c.id, 'failed');
            warmPool.deleteByContainer(c.id);
            reconciled++;
        } else if (actualStatus.startsWith('Exited') || actualStatus === 'Dead') {
            // Dead on worker but DB says alive → mark failed
            logger.warn(`[Reconcile] ${c.container_name} exited on worker but DB says ${c.status} → failed`);
            containers.updateStatus(c.id, 'failed');
            warmPool.deleteByContainer(c.id);
            reconciled++;
        } else if (actualStatus.startsWith('Up') && c.status === 'paused') {
            // Running on worker but DB says paused → update DB
            logger.info(`[Reconcile] ${c.container_name} running on worker but DB says paused → running`);
            containers.updateStatus(c.id, 'running');
            reconciled++;
        } else if (actualStatus.startsWith('Paused') && c.status === 'running') {
            // Paused on worker but DB says running → update DB
            logger.info(`[Reconcile] ${c.container_name} paused on worker but DB says running → paused`);
            containers.updateStatus(c.id, 'paused');
            reconciled++;
        }
    }

    return reconciled;
}

// ─── Gateway Cache Invalidation ──────────────────────────────────────────────
/**
 * Notify the gateway to invalidate its container cache when a worker is deleted.
 * This prevents the gateway from routing to dead containers for up to 30s (TTL).
 */
async function invalidateGatewayCache() {
    const gatewayUrl = process.env.GATEWAY_URL;
    if (!gatewayUrl) return; // Gateway URL not configured — skip

    try {
        const http = require('http');
        const url = new URL('/internal/invalidate', gatewayUrl);

        await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                timeout: 5000,
            }, (res) => {
                res.resume(); // drain response
                if (res.statusCode >= 200 && res.statusCode < 300) resolve();
                else reject(new Error(`Gateway returned ${res.statusCode}`));
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            req.write(JSON.stringify({ prefix: 'ct:' }));
            req.end();
        });

        logger.info('[GatewayCache] Invalidated container cache on gateway');
    } catch (err) {
        logger.debug(`[GatewayCache] Invalidation failed: ${err.message}`);
    }
}

module.exports = { startMonitoring, stopMonitoring, runHealthCheckCycle, invalidateGatewayCache };
