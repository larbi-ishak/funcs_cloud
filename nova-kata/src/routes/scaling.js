const express = require('express');
const router = express.Router();

const { scaleOut, scaleIn, getMetrics } = require('../services/scalingService');
const { AVAILABLE_REGIONS } = require('../services/gcpService');
const logger = require('../utils/logger');

// ─── GET /scaling/regions ─────────────────────────────────────────────────────
/**
 * Returns the list of supported logical regions the user can choose from
 * when deploying a new worker.
 */
router.get('/scaling/regions', (req, res) => {
    res.json({ regions: AVAILABLE_REGIONS });
});

// ─── GET /scaling/metrics ─────────────────────────────────────────────────────
/**
 * Returns current cluster load metrics and scaling state.
 */
router.get('/scaling/metrics', async (req, res) => {
    res.json(await getMetrics());
});

// ─── POST /scaling/scale-out ──────────────────────────────────────────────────
/**
 * Manually trigger a scale-out (create a new GCP worker).
 * Streams live logs via Server-Sent Events.
 *
 * Body: { region: 'europe' }   (see GET /scaling/regions for valid ids)
 *
 * SSE events:
 *   event: log   → { line: string }
 *   event: done  → { worker, instanceName, zone }
 *   event: error → { error: string }
 */
router.post('/scaling/scale-out', async (req, res) => {
    const { region } = req.body;

    if (!region) {
        return res.status(400).json({ error: 'Missing required field: region' });
    }

    if (!process.env.GCP_PROJECT_ID) {
        return res.status(503).json({ error: 'GCP is not configured (GCP_PROJECT_ID missing)' });
    }

    // ── SSE setup ─────────────────────────────────────────────────────────────
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
        send('log', { line: `🌍 Initiating scale-out in region "${region}"...` });

        const result = await scaleOut({
            region,
            onLine: (line) => send('log', { line }),
        });

        send('done', result);
        res.end();
    } catch (err) {
        logger.error(`[scaling route] scale-out failed: ${err.message}`);
        send('error', { error: err.message });
        res.end();
    }
});

// ─── POST /scaling/scale-in ───────────────────────────────────────────────────
/**
 * Remove a GCP-backed worker — retires it in DB and deletes the VM.
 *
 * Body: { workerId: string }
 */
router.post('/scaling/scale-in', async (req, res) => {
    const { workerId } = req.body;

    if (!workerId) {
        return res.status(400).json({ error: 'Missing required field: workerId' });
    }

    if (!process.env.GCP_PROJECT_ID) {
        return res.status(503).json({ error: 'GCP is not configured (GCP_PROJECT_ID missing)' });
    }

    try {
        await scaleIn(workerId);
        return res.json({ success: true, message: `Worker ${workerId} scaled in and VM deleted` });
    } catch (err) {
        logger.error(`[scaling route] scale-in failed: ${err.message}`);
        return res.status(500).json({ error: err.message });
    }
});

module.exports = router;
