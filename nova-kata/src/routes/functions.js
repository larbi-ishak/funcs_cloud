const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { functions, apiKeys } = require('../db/database');
const logger = require('../utils/logger');

// ─── POST /functions ──────────────────────────────────────────────────────────
/**
 * Register a new function.
 * Body: { name, image, region, agent_cmd?, agent_port?, env_vars?, auth_policy? }
 */
router.post('/functions', (req, res) => {
    const { name, image, region } = req.body;

    if (!name || !image || !region) {
        return res.status(400).json({
            error: 'Missing required fields: name, image, region',
        });
    }

    // Check for duplicate
    const existing = functions.findByNameAndRegion(name, region);
    if (existing) {
        return res.status(409).json({ error: `Function '${name}' already exists in region '${region}'` });
    }

    const id = uuidv4();
    functions.insert({
        id,
        name,
        image,
        region,
        agent_cmd: req.body.agent_cmd || 'python3 /nova_agent.py',
        agent_port: req.body.agent_port || 8080,
        env_vars: req.body.env_vars ? JSON.stringify(req.body.env_vars) : null,
        status: 'active',
        auth_policy: req.body.auth_policy || 'public',
    });

    logger.info(`Function '${name}' registered as ${id}`);
    return res.status(201).json({ success: true, function: functions.findById(id) });
});

// ─── GET /functions ───────────────────────────────────────────────────────────
router.get('/functions', (req, res) => {
    const all = functions.findAll();
    return res.json({ functions: all, total: all.length });
});

// ─── GET /functions/:id ───────────────────────────────────────────────────────
router.get('/functions/:id', (req, res) => {
    const func = functions.findById(req.params.id);
    if (!func) return res.status(404).json({ error: 'Function not found' });

    const keys = apiKeys.findByFunction(req.params.id);
    const { invocations } = require('../db/database');
    const invs = invocations.findByFunction(req.params.id);
    return res.json({ function: func, api_keys: keys, invocations: invs });
});

// ─── DELETE /functions/:id ────────────────────────────────────────────────────
router.delete('/functions/:id', (req, res) => {
    const func = functions.findById(req.params.id);
    if (!func) return res.status(404).json({ error: 'Function not found' });

    functions.delete(req.params.id);
    logger.info(`Function ${req.params.id} deleted`);
    return res.json({ success: true });
});

// ─── POST /functions/:id/keys ─────────────────────────────────────────────────
/**
 * Generate an API key for a function.
 */
router.post('/functions/:id/keys', (req, res) => {
    const func = functions.findById(req.params.id);
    if (!func) return res.status(404).json({ error: 'Function not found' });

    const id = uuidv4();
    const key = `nk_${uuidv4().replace(/-/g, '')}`;

    apiKeys.insert({
        id,
        key,
        function_id: req.params.id,
        status: 'active',
    });

    logger.info(`API key generated for function ${req.params.id}`);
    return res.status(201).json({ success: true, api_key: { id, key } });
});

// ─── POST /invocations ────────────────────────────────────────────────────────
router.post('/invocations', (req, res) => {
    const { function_id, container_id, status_code, latency_ms, request_method, request_path } = req.body;
    if (!function_id) return res.status(400).json({ error: 'function_id is required' });

    const { invocations } = require('../db/database');
    invocations.insert({
        id: uuidv4(),
        function_id,
        container_id: container_id || null,
        status_code: status_code || 200,
        latency_ms: latency_ms || 0,
        request_method: request_method || 'GET',
        request_path: request_path || '/'
    });

    return res.status(201).json({ success: true });
});

module.exports = router;
