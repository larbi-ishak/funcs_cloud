import cache from '../cache/cache.js';
import { containers } from '../db/database.js';
import axios from 'axios';
import http from 'http';
import logger from '../utils/logger.js';

const PLACEMENT_URL = process.env.PLACEMENT_SERVICE_URL || 'http://localhost:3002';
const PLACEMENT_TIMEOUT_MS = parseInt(process.env.PLACEMENT_TIMEOUT_MS) || 15000; // 15s — Kata cold starts take 8-10s

// ── Persistent HTTP connection to Placement Service ────────────────────────
// Reuses TCP connections (keep-alive) instead of creating a new one per request.
// Saves ~20-50ms TCP handshake on cold-start claims.
const placementClient = axios.create({
    baseURL: PLACEMENT_URL,
    httpAgent: new http.Agent({
        keepAlive: true,
        keepAliveMsecs: 30000,
        maxSockets: 10,
    }),
    timeout: PLACEMENT_TIMEOUT_MS,
});

// ── Single-flight lock for cold start claims ──────────────────────────────
// If 50 concurrent requests miss cache for the same function, only 1 calls
// the placement service. The other 49 await the same Promise.
const pendingClaims = new Map();

// ── Track unpaused containers ──────────────────────────────────────────────
// Warm pool containers are paused (frozen) to save resources. Before proxying,
// we must unpause them. This Set tracks which containers have been unpaused
// so we don't call unpause on every request.
// When a container is released back to the warm pool (cache expires), it gets
// re-paused, so we remove it from this set.
const unpausedContainers = new Set();

// ── When a container cache entry expires, the container is re-paused ────────
// (via the release endpoint). Remove it from the unpaused set so the next
// request will unpause it again.
cache.on('expired', (key, value) => {
    if (key.startsWith('ct:') && value) {
        const entries = value.containers || (value.container_id ? [value] : []);
        for (const c of entries) {
            if (c.container_id) unpausedContainers.delete(c.container_id);
        }
    }
});

export default async function containerStateCheck(req, res, next) {
    const t0 = performance.now();
    const { functionData, functionName } = req;
    const cacheKey = `ct:${functionName}`;

    // Guard: existenceCheck must set req.functionData before this middleware runs
    if (!functionData) {
        return res.status(500).json({ error: "function data missing" });
    }

    try {
        // ── Step 1: Check cache for container pool ────────────────────────────
        let pool = await cache.get(cacheKey);

        if (pool && pool.containers && pool.containers.length > 0) {
            // Round-robin: pick the next container in the pool
            const idx = pool.nextIndex % pool.containers.length;
            pool.nextIndex++;
            // Fire-and-forget: update the index in cache for next request
            cache.set(cacheKey, pool).catch(() => {});

            const chosen = pool.containers[idx];

            // ── Unpause warm container if needed ──────────────────────────────
            // Warm pool containers are paused (frozen). Before proxying, we must
            // unpause them. We track which containers are already unpaused to
            // avoid calling unpause on every request (~200ms overhead).
            if (chosen.container_id && !unpausedContainers.has(chosen.container_id)) {
                try {
                    const unpauseStart = performance.now();
                    await placementClient.post(`/containers/${chosen.container_id}/unpause`, {}, {
                        timeout: parseInt(process.env.UNPAUSE_TIMEOUT_MS) || 5000,
                    });
                    unpausedContainers.add(chosen.container_id);
                    req.log.info({
                        elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
                        functionName, container_id: chosen.container_id,
                        unpause_ms: +(performance.now() - unpauseStart).toFixed(2),
                    }, 'container_unpaused');
                } catch (unpauseErr) {
                    // Container might already be running, or unpause failed.
                    // If it's already running, the proxy will succeed.
                    // If it truly failed, the proxy will timeout and return 502.
                    req.log.info({
                        container_id: chosen.container_id,
                        error: unpauseErr.message,
                    }, 'unpause_failed_or_already_running');
                    // Assume it's already running and add to set to avoid retrying
                    unpausedContainers.add(chosen.container_id);
                }
            }

            // Refresh the idle TTL — activity resets the idle timer.
            cache.ttl(cacheKey, parseInt(process.env.CONTAINER_IDLE_TTL) || 300);
            req.log.info({
                elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
                functionName, pool_size: pool.containers.length, chosen_index: idx,
                step_ms: +(performance.now() - t0).toFixed(2),
            }, 'containerStateCheck_cache_hit');

            req.vmTarget = chosen.vmTarget;
            req.containerId = chosen.container_id;
            return next();
        }

        req.log.info({
            elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
            functionName, step_ms: +(performance.now() - t0).toFixed(2),
        }, 'containerStateCheck_cache_miss');

        // ── Step 2: Query DB for ALL running containers ──────────────────────
        const tDb = performance.now();
        const runningContainers = containers.findAllRunningByFunction(functionData.id);
        const dbElapsed = +(performance.now() - tDb).toFixed(2);

        if (runningContainers.length > 0) {
            // Build a pool of all running containers for round-robin routing
            const containerEntries = [];
            for (const c of runningContainers) {
                if (!c.container_ip) continue;
                let hostIp = null;
                if (c.metadata) {
                    try { const meta = JSON.parse(c.metadata); hostIp = meta.host_ip; } catch (_) { }
                }
                containerEntries.push({
                    host_ip:      hostIp || c.container_ip,
                    host_port:    c.host_port,
                    container_id: c.id,
                    vmTarget:     `http://${hostIp || c.container_ip}:${c.host_port}`,
                });
            }

            if (containerEntries.length > 0) {
                pool = { containers: containerEntries, nextIndex: 0 };
                req.log.info({
                    elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
                    functionName, db_query_ms: dbElapsed, pool_size: containerEntries.length,
                    step_ms: +(performance.now() - t0).toFixed(2),
                }, 'containerStateCheck_db_hit');
                await cache.set(cacheKey, pool);

                // Pick first container (index 0)
                req.vmTarget = containerEntries[0].vmTarget;
                req.containerId = containerEntries[0].container_id;
                return next();
            }
        }

        req.log.info({
            elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
            functionName, db_query_ms: dbElapsed, step_ms: +(performance.now() - t0).toFixed(2),
        }, 'containerStateCheck_db_miss');

        // ── Step 3: Claim from warm pool via Placement Service ────────────────
        // Single-flight lock: if a claim is already in progress for this function,
        // await the existing Promise instead of firing another request.
        logger.info(`Claiming warm container for ${functionName} — calling Nova Kata`);
        const tPlacement = performance.now();

        try {
            if (!pendingClaims.has(functionData.id)) {
                const claimPromise = placementClient.post('/execute', {
                    function_id: functionData.id,
                }).finally(() => pendingClaims.delete(functionData.id));

                pendingClaims.set(functionData.id, claimPromise);
            }

            // All concurrent requests await the same Promise
            const response = await pendingClaims.get(functionData.id);
            const placementElapsed = +(performance.now() - tPlacement).toFixed(2);

            if (response.data && response.data.success) {
                const ct = response.data.container;
                const newEntry = {
                    host_ip:      ct.host_ip || '127.0.0.1',
                    host_port:    ct.host_port || 9999,
                    container_id: ct.container_id,
                    vmTarget:     `http://${ct.host_ip || '127.0.0.1'}:${ct.host_port || 9999}`,
                };

                // Cache as a single-container pool (next DB miss will refresh with all running)
                pool = { containers: [newEntry], nextIndex: 0 };

                req.log.info({
                    elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
                    functionName, placement_call_ms: placementElapsed,
                    source: ct.source, target: `${newEntry.host_ip}:${newEntry.host_port}`,
                    step_ms: +(performance.now() - t0).toFixed(2),
                }, 'containerStateCheck_claim_done');
                await cache.set(cacheKey, pool);

                req.vmTarget = newEntry.vmTarget;
                req.containerId = newEntry.container_id;
                next();
            } else {
                throw new Error("Placement service returned an error");
            }
        } catch (error) {
            const placementElapsed = +(performance.now() - tPlacement).toFixed(2);
            req.log.info({
                elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
                functionName, placement_call_ms: placementElapsed, error: error.message,
            }, 'containerStateCheck_claim_failed');
            logger.error({ functionName }, `Failed to claim container: ${error.message}`);
            return res.status(503).setHeader('Retry-After', '2').json({
                error: "function temporarily unavailable",
                request_id: req.requestId,
            });
        }
    } catch (err) {
        req.log.info({
            elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
            error: err.message,
        }, 'containerStateCheck_error');
        logger.error({ err }, 'Container State Check error');
        return res.status(500).json({ error: "internal error determining container state" });
    }
}