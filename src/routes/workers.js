const express = require('express');
const router = express.Router();

const { initWorker, checkWorkerHealth, retireWorker, InitError } = require('../services/workerService');
const { workers, microvms, events } = require('../db/database');
const logger = require('../utils/logger');

// ─── POST /init ───────────────────────────────────────────────────────────────
/**
 * Register and validate a new Worker VM.
 *
 * Body: { ip, username, password, ssh_port?, firecracker_path?,
 *         kernel_image_path?, rootfs_path?, fc_socket_dir? }
 */
router.post('/init', async (req, res) => {
    const { ip, username, password } = req.body;

    if (!ip || !username || !password) {
        return res.status(400).json({
            error: 'Missing required fields: ip, username, password',
        });
    }

    try {
        const worker = await initWorker(req.body);
        return res.status(201).json({ success: true, worker });
    } catch (err) {
        if (err instanceof InitError) {
            logger.warn(`Worker init failed [${err.code}]: ${err.message}`);
            return res.status(422).json({
                error: err.message,
                code: err.code,
            });
        }
        logger.error(`Worker init error: ${err.message}`);
        return res.status(500).json({ error: 'Internal server error' });
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
    const activeMicroVMs = microvms.findByWorker(req.params.id);

    return res.json({
        worker: sanitize(worker),
        active_microvms: activeMicroVMs,
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
/**
 * Mark a worker as retired (optionally delete it).
 * Body: { remove?: boolean }
 */
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

    workers.delete(req.params.id);
    logger.info(`Worker ${req.params.id} deleted`);
    return res.json({ success: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sanitize(worker) {
    const { password, ...safe } = worker;
    return safe;
}

module.exports = router;
