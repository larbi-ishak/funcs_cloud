const express = require('express');
const router = express.Router();

const { initWorker, checkWorkerHealth, retireWorker, InitError } = require('../services/workerService');
const { provisionWorker, ProvisionError } = require('../services/provisionService');
const { workers, containers, warmPool, events } = require('../db/database');
const logger = require('../utils/logger');

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
