const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { buildFunctionImage, deleteFunctionResources } = require('../services/buildService');
const { launchContainer, stopContainer } = require('../services/containerService');
const { pickWorker } = require('../services/schedulerService');
const { functions, warmPool, containers } = require('../db/database');
const logger = require('../utils/logger');

const WARM_POOL_MIN = parseInt(process.env.WARM_POOL_MIN) || 2;
const DEFAULT_RUNTIME = process.env.DEFAULT_RUNTIME || 'io.containerd.kata.v2';
const DEFAULT_AGENT_PORT = parseInt(process.env.DEFAULT_AGENT_PORT) || 8080;

// ── Multer: store uploaded files in memory (we base64-send them to the worker) ─
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB per file
});

/**
 * POST /functions/deploy
 *
 * Accepts multipart/form-data:
 *   fields:  name, region, runtime, entry_point, requirements_file, agent_port, warm_count
 *   files:   files[]  (the user's source directory, sent via webkitdirectory input)
 *
 * Response: SSE stream of build log lines, then a final JSON summary event.
 */
router.post('/functions/deploy', upload.array('files'), async (req, res) => {
    const {
        name, region,
        runtime = 'python',
        entry_point,
        requirements_file,
        agent_port,
        warm_count,
        env_vars,
        memory_limit,
        cpu_limit,
        storage_limit,
        max_containers
    } = req.body;

    const uploadedFiles = req.files || [];

    if (!name || !region) {
        return res.status(400).json({ error: 'Missing required fields: name, region' });
    }
    if (!entry_point) {
        return res.status(400).json({ error: 'Missing entry_point: specify which file is the handler' });
    }
    if (uploadedFiles.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
    }

    const functionName = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const agentPort = agent_port || DEFAULT_AGENT_PORT;
    const targetWarm = parseInt(warm_count) >= 0 ? parseInt(warm_count) : 1;

    // ── SSE setup ────────────────────────────────────────────────────────────
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
    res.flushHeaders();

    const send = (type, data) => {
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const log = (message, level = 'info') => {
        send('log', { message, level, ts: new Date().toISOString() });
        logger.info(`[deploy:${functionName}] ${message}`);
    };

    const finish = (success, payload = {}) => {
        send('done', { success, ...payload });
        res.end();
    };

    try {
        // ── 1. Pick a worker for the build ────────────────────────────────────
        let worker;
        try {
            worker = pickWorker();
        } catch (err) {
            log(`❌ No healthy workers available: ${err.message}`, 'error');
            return finish(false, { error: err.message });
        }
        log(`🖥️  Using worker ${worker.ip} for build`, 'step');

        // ── 2. Build the image ────────────────────────────────────────────────
        // Image tag is set by buildFunctionImage using REGISTRY_HOST
        let buildResult;
        try {
            // multer may strip directory from originalname (security feature).
            // The frontend also sends matching file_paths[] fields with the full
            // relative paths (e.g. 'services/info.py'). We zip them together here.
            const filePaths = req.body.file_paths
                ? (Array.isArray(req.body.file_paths) ? req.body.file_paths : [req.body.file_paths])
                : [];

            const files = uploadedFiles.map((f, i) => {
                // Prefer the explicit path sent by the frontend; fall back to originalname
                const resolvedPath = filePaths[i] || f.originalname;
                log(`  📄 ${resolvedPath} (${f.size} bytes)`, 'info');
                return { name: resolvedPath, content: f.buffer };
            });

            buildResult = await buildFunctionImage(
                worker,
                {
                    name: functionName,
                    runtime,
                    entryPoint: entry_point,
                    requirementsFile: requirements_file || guessRequirementsFile(runtime, files),
                    files,
                    agentPort,
                },
                (line, level) => log(line, level)
            );
        } catch (err) {
            log(`❌ Build failed: ${err.message}`, 'error');
            return finish(false, { error: `Build failed: ${err.message}` });
        }

        // ── 3. Register function in DB ────────────────────────────────────────
        // agent_cmd: run the user's entry point directly — they own the HTTP server
        const runtimeCmds = {
            python: `python3 /function/${entry_point}`,
            nodejs: `node /function/${entry_point}`,
            php:    `php -S 0.0.0.0:8080 /function/${entry_point}`,
            ruby:   `ruby /function/${entry_point}`,
            golang: `./main`,
            java:   `java -jar /function/${entry_point}`,
            dotnet: `dotnet ${entry_point}`
        };
        const agentCmd = runtimeCmds[runtime] || `python3 /function/${entry_point}`;

        let func = functions.findByNameAndRegion(functionName, region);
        if (!func) {
            const funcId = uuidv4();
            functions.insert({
                id: funcId,
                name: functionName,
                image: buildResult.image,
                region,
                agent_cmd: agentCmd,
                agent_port: agentPort,
                env_vars: env_vars ? env_vars : null,
                memory_limit: memory_limit ? parseInt(memory_limit) : 512,
                cpu_limit: cpu_limit ? parseFloat(cpu_limit) : 1.0,
                storage_limit: storage_limit ? parseInt(storage_limit) : 512,
                max_containers: max_containers ? parseInt(max_containers) : 10,
                warm_count: targetWarm,
                status: 'active',
                auth_policy: 'public',
            });
            func = functions.findById(funcId);
            log(`📦 Function '${functionName}' registered (id: ${func.id})`, 'step');
        } else {
            // Update function record with new image and settings
            log(`📦 Function '${functionName}' already exists — updating image`, 'step');
            functions.update(func.id, {
                image: buildResult.image,
                agent_cmd: agentCmd,
                agent_port: agentPort,
                env_vars: env_vars || null,
                memory_limit: memory_limit ? parseInt(memory_limit) : null,
                cpu_limit: cpu_limit ? parseFloat(cpu_limit) : null,
                warm_count: targetWarm,
            });
            func = functions.findById(func.id); // Refresh from DB

            // Stop old containers running the previous image
            const oldContainers = containers.findAll().filter(
                c => c.function_id === func.id && c.status !== 'stopped' && c.status !== 'failed'
            );
            if (oldContainers.length > 0) {
                log(`🧹 Stopping ${oldContainers.length} old container(s) with previous image...`, 'step');
                for (const c of oldContainers) {
                    try { await stopContainer(c.id); } catch (_) { /* best effort */ }
                }
                warmPool.removeByFunctionId(func.id);
            }

            // Invalidate gateway cache so it picks up the new image
            try {
                const { invalidateGatewayCache } = require('../services/monitoringService');
                invalidateGatewayCache();
            } catch (_) {}
        }

        // ── 4. Pre-warm containers ────────────────────────────────────────────
        log(`🔥 Pre-warming ${targetWarm} container(s)...`, 'step');
        const warmed = [];

        for (let i = 0; i < targetWarm; i++) {
            try {
                log(`  [${i + 1}/${targetWarm}] Launching warm container...`, 'info');
                const container = await launchContainer(worker.id, {
                    image: buildResult.image,
                    agent_cmd: agentCmd,
                    agent_port: agentPort,
                    env_vars: env_vars ? JSON.parse(env_vars) : undefined,
                    memory_limit: memory_limit ? parseInt(memory_limit) : undefined,
                    cpu_limit: cpu_limit ? parseFloat(cpu_limit) : undefined,
                    storage_limit: storage_limit ? parseInt(storage_limit) : undefined,
                    function_id: func.id,
                    pause_after: true,
                });

                warmPool.insert({
                    container_id: container.id,
                    worker_id: worker.id,
                    function_id: func.id,
                    status: 'warm',
                });

                warmed.push(container.id);
                log(`  ✅ Warm container ${container.container_name} ready (paused)`, 'info');
            } catch (err) {
                log(`  ⚠️  Failed to create warm container ${i + 1}: ${err.message}`, 'error');
            }
        }

        log(`🎉 Deploy complete! ${warmed.length}/${targetWarm} warm containers ready.`, 'step');

        finish(true, {
            function: {
                id: func.id,
                name: functionName,
                image: buildResult.image,
                region,
                runtime,
            },
            warm_containers: warmed.length,
        });

    } catch (err) {
        logger.error(`Deploy error: ${err.message}`);
        log(`❌ Unexpected error: ${err.message}`, 'error');
        finish(false, { error: err.message });
    }
});

/**
 * GET /functions/deploy/status
 * Returns the current warm pool status for all functions (for dashboard polling).
 */
router.get('/functions/deploy/status', (req, res) => {
    const allFunctions = functions.findAll();

    const result = allFunctions.map(f => {
        const warm = warmPool.findAll().filter(e => e.function_id === f.id && e.status === 'warm');
        const claimed = warmPool.findAll().filter(e => e.function_id === f.id && e.status === 'claimed');
        return {
            id: f.id,
            name: f.name,
            region: f.region,
            image: f.image,
            runtime: f.runtime || 'python',
            status: f.status,
            warm_count: warm.length,
            claimed_count: claimed.length,
        };
    });

    res.json({ functions: result });
});

// ─── DELETE /functions/:id ───────────────────────────────────────────────────
/**
 * Deletes a function and ALL its resources:
 *  - stops & removes every warm/active container on the worker
 *  - removes the nerdctl image from the worker
 *  - cleans the build directory on the worker
 *  - purges warm_pool entries and the function record from SQLite
 */
router.delete('/functions/:id', async (req, res) => {
    const func = functions.findById(req.params.id);
    if (!func) return res.status(404).json({ error: 'Function not found' });

    const log = (msg) => logger.info(`[delete:${func.name}] ${msg}`);

    try {
        // Gather all container names for this function
        const allContainers = containers.findAll().filter(c => c.function_id === func.id);
        const containerNames = allContainers.map(c => c.container_name);

        log(`Stopping ${containerNames.length} container(s)...`);

        // Stop containers in Nova DB first (marks them stopped)
        for (const c of allContainers) {
            try { await stopContainer(c.id); } catch (_) { /* best effort */ }
        }

        // Remove image + build dir on every worker that has it
        // (currently functions are on one worker — use the one from DB)
        let worker = null;
        if (allContainers.length > 0) {
            const { workers } = require('../db/database');
            worker = workers.findById(allContainers[0].worker_id);
        }
        if (!worker) {
            // Try picking any registered worker
            try { worker = pickWorker(); } catch (_) {}
        }

        if (worker) {
            await deleteFunctionResources(worker, func.name, containerNames);
        } else {
            log('No worker found — skipping remote cleanup');
        }

        // Purge warm pool entries
        warmPool.removeByFunctionId(func.id);

        // Purge the function record
        functions.deleteById(func.id);

        log('✅ Function deleted successfully');
        res.json({ success: true, message: `Function '${func.name}' and all its resources have been deleted.` });

    } catch (err) {
        logger.error(`[delete:${func.name}] Failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Auto-detect the requirements file from uploaded files if the user didn't specify one.
 * Falls back to a sensible default per runtime.
 */
function guessRequirementsFile(runtime, files) {
    const names = files.map(f => f.name.split('/').pop());
    
    if (runtime === 'nodejs') return 'package.json';
    if (runtime === 'ruby') return 'Gemfile';
    if (runtime === 'golang') return 'go.mod';
    if (runtime === 'php') return 'composer.json';
    
    if (names.includes('requirements.txt')) return 'requirements.txt';
    if (names.includes('requirements.in'))  return 'requirements.in';
    return 'requirements.txt';
}

module.exports = router;
