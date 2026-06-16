const express = require('express');
const router = express.Router();

const { launchContainer, stopContainer, pauseContainer, unpauseContainer } = require('../services/containerService');
const { claimWarmContainer, replenishPool, getPoolStats } = require('../services/warmPoolService');
const { pickWorker, getPoolMetrics } = require('../services/schedulerService');
const { containers, warmPool } = require('../db/database');
const logger = require('../utils/logger');

// ─── POST /execute ────────────────────────────────────────────────────────────
/**
 * Execute a function — claim a warm container or cold-start a new one.
 * This is the primary invocation endpoint.
 *
 * Body (all optional):
 *   { function_id?, worker_id?, image?, env_vars?, agent_cmd?, agent_port? }
 */
router.post('/execute', async (req, res) => {
    try {
        const functionId = req.body.function_id || null;

        // Validate function exists before claiming — prevents FK constraint errors
        // when the gateway has a stale cached function_id from a deleted+re-deployed function
        if (functionId) {
            const { functions } = require('../db/database');
            const func = await functions.findById(functionId);
            if (!func) {
                logger.warn(`Execute rejected: function_id ${functionId} not found (stale gateway cache?)`);
                return res.status(404).json({
                    error: `Function not found: ${functionId}`,
                    hint: 'Gateway cache may be stale — invalidate fn: and ct: cache entries',
                });
            }
            if (func.status !== 'active') {
                logger.warn(`Execute rejected: function ${functionId} status is '${func.status}'`);
                return res.status(404).json({ error: `Function not available: status='${func.status}'` });
            }
        }

        const result = await claimWarmContainer(functionId);
        return res.status(200).json({ success: true, container: result });
    } catch (err) {
        logger.error(`Execute failed: ${err.message}`);
        return res.status(500).json({ error: err.message });
    }
});

// ─── POST /containers/launch ──────────────────────────────────────────────────
/**
 * Manually launch a container on a specific or auto-selected worker.
 */
router.post('/containers/launch', async (req, res) => {
    let worker;

    try {
        if (req.body.worker_id) {
            const { workers } = require('../db/database');
            worker = await workers.findById(req.body.worker_id);
            if (!worker) return res.status(404).json({ error: 'Specified worker not found' });
        } else {
            worker = await pickWorker();
        }
    } catch (err) {
        return res.status(503).json({ error: err.message });
    }

    try {
        const container = await launchContainer(worker.id, {
            image: req.body.image,
            env_vars: req.body.env_vars,
            function_id: req.body.function_id,
            function_name: req.body.function_name || null,
            agent_cmd: req.body.agent_cmd,
            agent_port: req.body.agent_port,
            pause_after: req.body.pause_after || false,
        });
        return res.status(201).json({ success: true, container });
    } catch (err) {
        logger.error(`Container launch failed: ${err.message}`);
        return res.status(500).json({ error: err.message });
    }
});

// ─── POST /containers/:id/pause ───────────────────────────────────────────────
router.post('/containers/:id/pause', async (req, res) => {
    try {
        await pauseContainer(req.params.id);
        return res.json({ success: true, message: `Container ${req.params.id} paused` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─── POST /containers/:id/unpause ─────────────────────────────────────────────
router.post('/containers/:id/unpause', async (req, res) => {
    try {
        const container = await unpauseContainer(req.params.id);
        return res.json({ success: true, container });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─── POST /containers/:id/release ─────────────────────────────────────────────
/**
 * Return a claimed container back to the warm pool.
 * Called by the gateway after an idle period (Lambda-style reuse):
 *   unpause → serve requests → idle → release (pause + mark warm) → ready for next claim
 */
router.post('/containers/:id/release', async (req, res) => {
    const container = await containers.findById(req.params.id);
    if (!container) return res.status(404).json({ error: 'Container not found' });

    try {
        await pauseContainer(req.params.id);

        // Return this container to the warm pool
        const existing = await warmPool.findByContainer(req.params.id);
        if (existing) {
            await warmPool.markWarm(req.params.id);
        } else {
            await warmPool.insert({
                container_id: container.id,
                worker_id:    container.worker_id,
                function_id:  container.function_id || null,
                status:       'warm',
            });
        }

        logger.info(`Container ${req.params.id.slice(0,8)} released back to warm pool`);
        return res.json({ success: true, message: 'Container returned to warm pool' });
    } catch (err) {
        logger.error(`Release failed for ${req.params.id}: ${err.message}`);
        return res.status(500).json({ error: err.message });
    }
});

// ─── GET /containers ──────────────────────────────────────────────────────────
router.get('/containers', async (req, res) => {
    const all = await containers.findAll();
    return res.json({ containers: all, total: all.length });
});

// ─── GET /containers/:id ──────────────────────────────────────────────────────
router.get('/containers/:id', async (req, res) => {
    const container = await containers.findById(req.params.id);
    if (!container) return res.status(404).json({ error: 'Container not found' });
    return res.json({ container });
});

// ─── DELETE /containers/:id ───────────────────────────────────────────────────
router.delete('/containers/:id', async (req, res) => {
    const container = await containers.findById(req.params.id);
    if (!container) return res.status(404).json({ error: 'Container not found' });

    try {
        await stopContainer(req.params.id);
        return res.json({ success: true, message: `Container ${req.params.id} stopped` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─── GET /warm-pool ───────────────────────────────────────────────────────────
router.get('/warm-pool', async (req, res) => {
    const stats = await getPoolStats();
    return res.json(stats);
});

// ─── POST /warm-pool/replenish ────────────────────────────────────────────────
router.post('/warm-pool/replenish', async (req, res) => {
    try {
        await replenishPool(req.body.function_id || null);
        const stats = await getPoolStats();
        return res.json({ success: true, pool: stats });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─── GET /metrics ─────────────────────────────────────────────────────────────
router.get('/metrics', async (req, res) => {
    const metrics = await getPoolMetrics();
    const pool = await getPoolStats();
    return res.json({ ...metrics, warm_pool: pool });
});

module.exports = router;
