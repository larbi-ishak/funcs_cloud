const express = require('express');
const router = express.Router();

const { launchMicroVM, stopMicroVM } = require('../services/firecrackerService');
const { pickWorker, getPoolMetrics } = require('../services/schedulerService');
const { microvms } = require('../db/database');
const logger = require('../utils/logger');

// ─── POST /execute ────────────────────────────────────────────────────────────
/**
 * Schedule and launch a new MicroVM on the best available worker.
 *
 * Body (all optional):
 *   { worker_id?, boot_args?, metadata? }
 *
 * If worker_id is provided, it will be used directly.
 * Otherwise the scheduler picks the least-loaded healthy worker.
 */
router.post('/execute', async (req, res) => {
    let worker;

    try {
        if (req.body.worker_id) {
            // Caller pinned a specific worker
            const { workers } = require('../db/database');
            worker = workers.findById(req.body.worker_id);
            if (!worker) return res.status(404).json({ error: 'Specified worker not found' });
        } else {
            worker = pickWorker();
        }
    } catch (err) {
        return res.status(503).json({ error: err.message });
    }

    try {
        const vm = await launchMicroVM(worker.id, {
            boot_args: req.body.boot_args,
            metadata: req.body.metadata,
        });
        return res.status(201).json({ success: true, microvm: vm });
    } catch (err) {
        logger.error(`Execute failed: ${err.message}`);
        return res.status(500).json({ error: err.message });
    }
});

// ─── GET /microvms ────────────────────────────────────────────────────────────
router.get('/microvms', (req, res) => {
    const all = microvms.findAll();
    return res.json({ microvms: all, total: all.length });
});

// ─── GET /microvms/:id ────────────────────────────────────────────────────────
router.get('/microvms/:id', (req, res) => {
    const vm = microvms.findById(req.params.id);
    if (!vm) return res.status(404).json({ error: 'MicroVM not found' });
    return res.json({ microvm: vm });
});

// ─── DELETE /microvms/:id ─────────────────────────────────────────────────────
/**
 * Stop and clean up a MicroVM.
 */
router.delete('/microvms/:id', async (req, res) => {
    const vm = microvms.findById(req.params.id);
    if (!vm) return res.status(404).json({ error: 'MicroVM not found' });

    try {
        await stopMicroVM(req.params.id);
        return res.json({ success: true, message: `MicroVM ${req.params.id} stopped` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─── GET /metrics ─────────────────────────────────────────────────────────────
router.get('/metrics', (req, res) => {
    const metrics = getPoolMetrics();
    return res.json(metrics);
});

module.exports = router;
