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
router.post('/init', async (req, res) => {
    const { ip, username, password, ssh_port, provision = false } = req.body;

    if (!ip || !username || !password) {
        return res.status(400).json({
            error: 'Missing required fields: ip, username, password',
        });
    }

    try {
        if (provision) {
            logger.info(`Provision flag set — running Ansible on worker ${ip}`);
            await provisionWorker({ ip, username, password, ssh_port });
        }

        const worker = await initWorker(req.body);
        return res.status(201).json({ success: true, worker, provisioned: provision });

    } catch (err) {
        if (err instanceof ProvisionError) {
            logger.error(`Ansible provisioning failed [${err.code}]: ${err.message}`);
            return res.status(502).json({ error: err.message, code: err.code, stage: 'provision' });
        }
        if (err instanceof InitError) {
            logger.warn(`Worker validation failed [${err.code}]: ${err.message}`);
            return res.status(422).json({ error: err.message, code: err.code, stage: 'validate' });
        }
        logger.error(`Worker init error: ${err.message}`);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── POST /provision/stream ───────────────────────────────────────────────────
router.post('/provision/stream', async (req, res) => {
    const { ip, username, password, ssh_port } = req.body;

    if (!ip || !username || !password) {
        return res.status(400).json({ error: 'Missing required fields: ip, username, password' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
        send('log', { line: `🚀 Starting Ansible provisioning for ${ip}...` });

        await provisionWorker({
            ip, username, password, ssh_port,
            onLine: (line) => send('log', { line }),
        });

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
router.get('/workers', async (req, res) => {
    const all = (await workers.findAll()).map(sanitize);
    return res.json({ workers: all, total: all.length });
});

// ─── GET /workers/:id ─────────────────────────────────────────────────────────
router.get('/workers/:id', async (req, res) => {
    const worker = await workers.findById(req.params.id);
    if (!worker) return res.status(404).json({ error: 'Worker not found' });

    const workerEvents = await events.findByWorker(req.params.id);

    return res.json({
        worker: sanitize(worker),
        recent_events: workerEvents,
    });
});

// ─── POST /workers/:id/check ──────────────────────────────────────────────────
router.post('/workers/:id/check', async (req, res) => {
    const worker = await workers.findById(req.params.id);
    if (!worker) return res.status(404).json({ error: 'Worker not found' });

    try {
        const result = await checkWorkerHealth(req.params.id);
        return res.json(result);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─── POST /workers/:id/retire ─────────────────────────────────────────────────
router.post('/workers/:id/retire', async (req, res) => {
    const worker = await workers.findById(req.params.id);
    if (!worker) return res.status(404).json({ error: 'Worker not found' });

    try {
        retireWorker(req.params.id, { remove: req.body.remove === true });
        return res.json({ success: true, message: `Worker ${req.params.id} retired` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─── POST /workers/:id/retry ──────────────────────────────────────────────────
router.post('/workers/:id/retry', async (req, res) => {
    const worker = await workers.findById(req.params.id);
    if (!worker) return res.status(404).json({ error: 'Worker not found' });

    try {
        const result = await resetAndRetryWorker(req.params.id);
        return res.json({ success: true, ...result });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─── GET /workers/:id/containers ─────────────────────────────────────────────
router.get('/workers/:id/containers', async (req, res) => {
    const worker = await workers.findById(req.params.id);
    if (!worker) return res.status(404).json({ error: 'Worker not found' });

    // Get containers from DB
    const dbContainers = (await containers.findAll()).filter(c => c.worker_id === req.params.id);

    // Enrich with function name
    const enriched = [];
    for (const c of dbContainers) {
        const fn = c.function_id ? await functions.findById(c.function_id) : null;
        enriched.push({
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
        });
    }

    // Try to get live status from Worker API
    let liveContainers = [];
    try {
        const psRes = await workerApiClient.get(`http://${worker.ip}:${WORKER_API_PORT}/ps`).catch(() => null);
        if (psRes) liveContainers = psRes.data.containers || [];
    } catch (_) {
        // Worker API unavailable — return DB data only
    }

    // Merge live status into DB records
    const liveMap = new Map(liveContainers.map(c => [c.name, c.status]));
    for (const c of enriched) {
        c.live_status = liveMap.get(c.container_name) || 'not_found';
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
router.get('/workers/:id/stats', async (req, res) => {
    const worker = await workers.findById(req.params.id);
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
router.get('/workers/ksm-stats', async (req, res) => {
    const allWorkers = (await workers.findAll()).filter(w => w.status === 'healthy');
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
router.delete('/workers/:id', async (req, res) => {
    const worker = await workers.findById(req.params.id);
    if (!worker) return res.status(404).json({ error: 'Worker not found' });

    // Cascade: remove warm pool entries and containers for this worker
    const workerContainers = await containers.findByWorker(req.params.id);
    await warmPool.removeByWorkerId(req.params.id);
    await containers.removeByWorkerId(req.params.id);
    logger.info(`Worker ${req.params.id}: cleaned up ${workerContainers.length} container(s) and warm pool entries`);

    await workers.delete(req.params.id);
    logger.info(`Worker ${req.params.id} deleted`);
    return res.json({ success: true, containers_removed: workerContainers.length });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sanitize(worker) {
    const { password, ...safe } = worker;
    return safe;
}

module.exports = router;