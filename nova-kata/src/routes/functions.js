const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const http = require('http');
const { functions, apiKeys, containers, workers } = require('../db/database');
const logger = require('../utils/logger');

// ── Worker API client ──────────────────────────────────────────────────────
const WORKER_API_KEY = process.env.WORKER_API_KEY || 'nova-worker-default-key';
const WORKER_API_PORT = parseInt(process.env.WORKER_API_PORT) || 3005;
const workerApiClient = axios.create({
    httpAgent: new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 10 }),
    timeout: 15000,
    headers: { 'X-Worker-Key': WORKER_API_KEY },
});

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

    // Validate image name format (prevents shell injection)
    const IMAGE_REGEX = /^(?:[a-zA-Z0-9._-]+(?::\d+)?\/)?[a-zA-Z0-9._-]+(?::[a-zA-Z0-9._-]+)?$/;
    if (!IMAGE_REGEX.test(image)) {
        return res.status(400).json({
            error: `Invalid image name: "${image}". Allowed format: [registry/]name[:tag]. No shell metacharacters allowed.`,
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

// ─── GET /functions/:id/stats ────────────────────────────────────────────────
/**
 * Get per-container CPU/RAM usage for a function by calling Worker API /container-stats.
 */
router.get('/functions/:id/stats', async (req, res) => {
    const func = functions.findById(req.params.id);
    if (!func) return res.status(404).json({ error: 'Function not found' });

    // Find all containers for this function
    const fnContainers = containers.findAll().filter(
        c => c.function_id === req.params.id && c.status !== 'stopped' && c.status !== 'failed'
    );

    if (fnContainers.length === 0) {
        return res.json({
            function_id: req.params.id,
            function_name: func.name,
            containers: [],
            aggregated: { cpu_percent: 0, memory_used_bytes: 0, memory_limit_bytes: 0 },
        });
    }

    // Group by worker to minimize API calls
    const byWorker = new Map();
    for (const c of fnContainers) {
        if (!byWorker.has(c.worker_id)) byWorker.set(c.worker_id, []);
        byWorker.get(c.worker_id).push(c);
    }

    // Fetch container stats from each worker
    const containerStats = [];
    for (const [workerId, workerContainers] of byWorker) {
        const worker = workers.findById(workerId);
        if (!worker) continue;

        try {
            const { data } = await workerApiClient.get(
                `http://${worker.ip}:${WORKER_API_PORT}/container-stats`
            );
            const statsMap = new Map(
                (data.containers || []).map(s => [s.name, s])
            );

            for (const c of workerContainers) {
                const stats = statsMap.get(c.container_name);
                containerStats.push({
                    container_id: c.id,
                    container_name: c.container_name,
                    status: c.status,
                    pids: stats?.pids || 0,
                });
            }
        } catch (_) {
            // Worker API unavailable — return zeros
            for (const c of workerContainers) {
                containerStats.push({
                    container_id: c.id,
                    container_name: c.container_name,
                    status: c.status,
                    pids: 0,
                });
            }
        }
    }

    // Aggregate
    const aggregated = {
        total_containers: containerStats.length,
        running_containers: containerStats.filter(c => c.status === 'running').length,
    };

    return res.json({
        function_id: req.params.id,
        function_name: func.name,
        containers: containerStats,
        aggregated,
    });
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

// ─── POST /invocations/batch ──────────────────────────────────────────────────
/**
 * Bulk-insert invocations from the gateway's batch buffer.
 * Uses a SQLite transaction for fast bulk insert (~10-100× faster than individual inserts).
 */
router.post('/invocations/batch', (req, res) => {
    const batch = req.body.invocations;
    if (!batch || !batch.length) return res.status(400).json({ error: 'empty batch' });

    const { getDb } = require('../db/database');
    const db = getDb();

    const insert = db.prepare(`
        INSERT INTO invocations (id, function_id, container_id, status_code, latency_ms, request_method, request_path)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((items) => {
        for (const item of items) {
            insert.run(
                uuidv4(),
                item.function_id,
                item.container_id || null,
                item.status_code || 200,
                item.latency_ms || 0,
                item.request_method || 'GET',
                item.request_path || '/'
            );
        }
    });

    insertMany(batch);
    return res.status(201).json({ success: true, inserted: batch.length });
});

module.exports = router;
