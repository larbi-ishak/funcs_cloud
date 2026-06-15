const express = require('express');
const router = express.Router();
const axios = require('axios');
const http = require('http');

const { initWorker, checkWorkerHealth, retireWorker, resetAndRetryWorker, InitError } = require('../services/workerService');
const { provisionWorker, ProvisionError } = require('../services/provisionService');
const { workers, containers, warmPool, events, functions } = require('../db/database');
const logger = require('../utils/logger');

// ── Worker API client ──────────────────────────────────────────────────────
const WORKER_API_KEY = process.env.WORKER_API_KEY || 'nova-worker-default-key';
const WORKER_API_PORT = parseInt(process.env.WORKER_API_PORT) || 3005;
const workerApiClient = axios.create({
    httpAgent: new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 10 }),
    timeout: 10000,
    headers: { 'X-Worker-Key': WORKER_API_KEY },
});

// ─── POST /init ───────────────────────────────────────────────────────────────
/**
 * Register and validate a new Worker VM.
 *
 * Body: { ip, username, password, ssh_port?, provision? }
 *
 * provision (boolean, optional):
 *   true  → run Ansible to install the full stack first, then validate.
 *   false → assume the worker is already set up; validate only (default).
 */
router.post('/init', async (req, res) => {
    const { ip, username, password, ssh_port, provision = false } = req.body;

    if (!ip || !username || !password) {
        return res.status(400).json({
            error: 'Missing required fields: ip, username, password',
        });
    }

    try {
        // ── Optional: run Ansible provisioning first ─────────────────────────
        if (provision) {
            logger.info(`Provision flag set — running Ansible on worker ${ip}`);
            await provisionWorker({ ip, username, password, ssh_port });
        }

        // ── Validate + register worker in DB ─────────────────────────────────
        const worker = await initWorker(req.body);
        return res.status(201).json({ success: true, worker, provisioned: provision });

    } catch (err) {
        if (err instanceof ProvisionError) {
            logger.error(`Ansible provisioning failed [${err.code}]: ${err.message}`);
            return res.status(502).json({
                error: err.message,
                code: err.code,
                stage: 'provision',
            });
        }
        if (err instanceof InitError) {
            logger.warn(`Worker validation failed [${err.code}]: ${err.message}`);
            return res.status(422).json({
                error: err.message,
                code: err.code,
                stage: 'validate',
            });
        }
        logger.error(`Worker init error: ${err.message}`);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── POST /provision/stream ───────────────────────────────────────────────────
/**
 * Provision a worker via Ansible with live log streaming (Server-Sent Events).
 *
 * Body: { ip, username, password, ssh_port? }
 *
 * The client receives a stream of SSE events:
 *   event: log    → one line of Ansible output
 *   event: done   → worker registered, data = { worker }
 *   event: error  → provisioning failed, data = { error, code, stage }
 *
 * Example (curl):
 *   curl -N -X POST http://localhost:3002/provision/stream \
 *        -H 'Content-Type: application/json' \
 *        -d '{"ip":"1.2.3.4","username":"root","password":"secret"}'
 */
router.post('/provision/stream', async (req, res) => {
    const { ip, username, password, ssh_port } = req.body;

    if (!ip || !username || !password) {
        return res.status(400).json({ error: 'Missing required fields: ip, username, password' });
    }

    // ── Set up SSE headers ───────────────────────────────────────────────────
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
        // ── Stream Ansible output line by line ───────────────────────────────
        send('log', { line: `🚀 Starting Ansible provisioning for ${ip}...` });

        await provisionWorker({
            ip, username, password, ssh_port,
            onLine: (line) => send('log', { line }),
        });

        // ── Validate + register in DB ────────────────────────────────────────
        send('log', { line: '✅ Provisioning complete — validating worker...' });
        const worker = await initWorker({ ip, username, password, ssh_port });

        send('done', { worker });
        res.end();

    } catch (err) {
        if (err instanceof ProvisionError) {
            send('error', { error: err.message, code: err.code, stage: 'provision' });
        } else if (err instanceof InitError) {
            send('error', { error: err.message, code: err.code, stage: 'validate' });
        } else {
            send('error', { error: err.message, code: 'UNKNOWN', stage: 'unknown' });
        }
        res.end();
    }
});

// ─── GET /workers ─────────────────────────────────────────────────────────────
router.get('/workers', (req, res) => {
    const all = workers.findAll().map(sanitize);
    return res.json({ workers: all, total: all.length });
});

// ─── GET /workers/:id ─────────────────────────────────────────────────────────
router.get('/workers/:id', (req, res) => {
    const worker = workers.findById(req.params.id);
    if (!worker) return res.status(404).json({ error: 'Worker not found' });

    const workerEvents = events.findByWorker(req.params.id);

    return res.json({
        worker: sanitize(worker),
        recent_events: workerEvents,
    });
});

// ─── POST /workers/:id/check ──────────────────────────────────────────────────
router.post('/workers/:id/check', async (req, res) => {
    const worker = workers.findById(req.params.id);
    if (!worker) return res.status(404).json({ error: 'Worker not found' });

    try {
        const result = await checkWorkerHealth(req.params.id);
        return res.json(result);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─── POST /workers/:id/retire ─────────────────────────────────────────────────
router.post('/workers/:id/retire', (req, res) => {
    const worker = workers.findById(req.params.id);
    if (!worker) return res.status(404).json({ error: 'Worker not found' });

    try {
        retireWorker(req.params.id, { remove: req.body.remove === true });
        return res.json({ success: true, message: `Worker ${req.params.id} retired` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─── POST /workers/:id/retry ──────────────────────────────────────────────────
/**
 * Reset a faulty/retired worker's failure count and immediately retry health check.
 * Use after manually fixing a worker (e.g., rebooting the VM).
 */
router.post('/workers/:id/retry', async (req, res) => {
    const worker = workers.findById(req.params.id);
    if (!worker) return res.status(404).json({ error: 'Worker not found' });

    try {
        const result = await resetAndRetryWorker(req.params.id);
        return res.json({ success: true, ...result });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─── GET /workers/:id/containers ─────────────────────────────────────────────
/**
 * List all containers for a worker, enriched with function name and live status.
 * Also calls Worker API /ps to get actual container status from the worker.
 */
router.get('/workers/:id/containers', async (req, res) => {
    const worker = workers.findById(req.params.id);
    if (!worker) return res.status(404).json({ error: 'Worker not found' });

    // Get containers from DB
    const dbContainers = containers.findAll().filter(c => c.worker_id === req.params.id);

    // Enrich with function name
    const enriched = dbContainers.map(c => {
        const fn = c.function_id ? functions.findById(c.function_id) : null;
        return {
            id: c.id,
            container_name: c.container_name,
            status: c.status,
            image: c.image,
            container_ip: c.container_ip,
            host_port: c.host_port,
            agent_port: c.agent_port,
            function_name: fn ? fn.name : null,
            function_id: c.function_id,
            started_at: c.started_at,
            stopped_at: c.stopped_at,
        };
    });

    // Try to get live status + container stats from Worker API
    let liveContainers = [];
    let containerStatsList = [];
    try {
        const [psRes, statsRes] = await Promise.allSettled([
            workerApiClient.get(`http://${worker.ip}:${WORKER_API_PORT}/ps`),
            workerApiClient.get(`http://${worker.ip}:${WORKER_API_PORT}/container-stats`),
        ]);
        if (psRes.status === 'fulfilled') liveContainers = psRes.value.data.containers || [];
        if (statsRes.status === 'fulfilled') containerStatsList = statsRes.value.data.containers || [];
    } catch (_) {
        // Worker API unavailable — return DB data only
    }

    // Merge live status + stats into DB records
    const liveMap = new Map(liveContainers.map(c => [c.name, c.status]));
    const statsMap = new Map(containerStatsList.map(c => [c.name, c]));
    for (const c of enriched) {
        c.live_status = liveMap.get(c.container_name) || 'not_found';
        const cs = statsMap.get(c.container_name);
        c.cpu_percent = cs?.cpu_percent || 0;
        c.memory_used_bytes = cs?.memory_used_bytes || 0;
        c.memory_limit_bytes = cs?.memory_limit_bytes || 0;
        c.memory_percent = cs?.memory_percent || 0;
        c.pids = cs?.pids || 0;
    }

    return res.json({
        worker_id: req.params.id,
        worker_ip: worker.ip,
        containers: enriched,
        total: enriched.length,
        live_available: liveContainers.length > 0,
    });
});

// ─── GET /workers/:id/stats ──────────────────────────────────────────────────
/**
 * Get real-time resource stats (RAM, CPU, disk) from a worker via Worker API.
 */
router.get('/workers/:id/stats', async (req, res) => {
    const worker = workers.findById(req.params.id);
    if (!worker) return res.status(404).json({ error: 'Worker not found' });

    try {
        const { data } = await workerApiClient.get(`http://${worker.ip}:${WORKER_API_PORT}/stats`);
        return res.json({
            worker_id: req.params.id,
            worker_ip: worker.ip,
            ...data,
        });
    } catch (err) {
        return res.status(502).json({
            error: `Worker API unavailable: ${err.message}`,
            worker_id: req.params.id,
            worker_ip: worker.ip,
        });
    }
});

// ─── GET /workers/ksm-stats ──────────────────────────────────────────────────
/**
 * Get KSM deduplication stats from all healthy workers.
 */
router.get('/workers/ksm-stats', async (req, res) => {
    const allWorkers = workers.findAll().filter(w => w.status === 'healthy');
    const results = [];

    for (const worker of allWorkers) {
        try {
            const { data } = await workerApiClient.get(
                `http://${worker.ip}:${WORKER_API_PORT}/ksm-stats`
            );
            results.push({ worker_id: worker.id, ip: worker.ip, ...data });
        } catch (err) {
            results.push({ worker_id: worker.id, ip: worker.ip, error: err.message });
        }
    }

    return res.json({ results });
});

// ─── DELETE /workers/:id ──────────────────────────────────────────────────────
router.delete('/workers/:id', (req, res) => {
    const worker = workers.findById(req.params.id);
    if (!worker) return res.status(404).json({ error: 'Worker not found' });

    // Cascade: remove warm pool entries and containers for this worker
    const workerContainers = containers.findByWorker(req.params.id);
    warmPool.removeByWorkerId(req.params.id);
    containers.removeByWorkerId(req.params.id);
    logger.info(`Worker ${req.params.id}: cleaned up ${workerContainers.length} container(s) and warm pool entries`);

    workers.delete(req.params.id);
    logger.info(`Worker ${req.params.id} deleted`);
    return res.json({ success: true, containers_removed: workerContainers.length });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sanitize(worker) {
    const { password, ...safe } = worker;
    return safe;
}

module.exports = router;
