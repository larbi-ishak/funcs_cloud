import cache from '../cache/cache.js';
import { containers } from '../db/database.js';
import axios from 'axios';
import http from 'http';
import logger from '../utils/logger.js';

const PLACEMENT_URL = process.env.PLACEMENT_SERVICE_URL || 'http://localhost:3002';
const PLACEMENT_TIMEOUT_MS = parseInt(process.env.PLACEMENT_TIMEOUT_MS) || 5000;

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

export default async function containerStateCheck(req, res, next) {
    const t0 = performance.now();
    const { functionData, functionName } = req;
    const cacheKey = `ct:${functionName}`;

    // Guard: existenceCheck must set req.functionData before this middleware runs
    if (!functionData) {
        return res.status(500).json({ error: "function data missing" });
    }

    try {
        // ── Step 1: Check cache (Redis or in-memory) ───────────────────────────
        let target = await cache.get(cacheKey);

        if (target) {
            // Refresh the idle TTL — activity resets the 30s idle timer.
            // Fire-and-forget: don't await — TTL refresh is not on the critical path.
            // Worst case if it fails: container expires a few seconds early → next request hits DB.
            cache.ttl(cacheKey, parseInt(process.env.CONTAINER_IDLE_TTL) || 30);
            req.log.info({
                elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
                functionName, step_ms: +(performance.now() - t0).toFixed(2),
            }, 'containerStateCheck_cache_hit');
        } else {
            req.log.info({
                elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
                functionName, step_ms: +(performance.now() - t0).toFixed(2),
            }, 'containerStateCheck_cache_miss');

            // ── Step 2: Query DB for a running container ──────────────────────
            const tDb = performance.now();
            const container = containers.findRunningByFunction(functionData.id);
            const dbElapsed = +(performance.now() - tDb).toFixed(2);

            if (container && container.container_ip) {
                let hostIp = null;
                if (container.metadata) {
                    try { const meta = JSON.parse(container.metadata); hostIp = meta.host_ip; } catch (_) { }
                }
                target = {
                    host_ip:      hostIp || container.container_ip,
                    host_port:    container.host_port,
                    container_id: container.id,
                    vmTarget:     `http://${hostIp || container.container_ip}:${container.host_port}`,
                };
                req.log.info({
                    elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
                    functionName, db_query_ms: dbElapsed, step_ms: +(performance.now() - t0).toFixed(2),
                }, 'containerStateCheck_db_hit');
                await cache.set(cacheKey, target);
            } else {
                req.log.info({
                    elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
                    functionName, db_query_ms: dbElapsed, step_ms: +(performance.now() - t0).toFixed(2),
                }, 'containerStateCheck_db_miss');

                // ── Step 3: Claim from warm pool via Placement Service ────────
                logger.info(`Claiming warm container for ${functionName} — calling Nova Kata`);
                const tPlacement = performance.now();

                try {
                    const response = await placementClient.post('/execute', {
                        function_id: functionData.id,
                    });
                    const placementElapsed = +(performance.now() - tPlacement).toFixed(2);

                    if (response.data && response.data.success) {
                        const ct = response.data.container;
                        target = {
                            host_ip:      ct.host_ip || '127.0.0.1',
                            host_port:    ct.host_port || 9999,
                            container_id: ct.container_id,
                            vmTarget:     `http://${ct.host_ip || '127.0.0.1'}:${ct.host_port || 9999}`,
                        };
                        req.log.info({
                            elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
                            functionName, placement_call_ms: placementElapsed,
                            source: ct.source, target: `${target.host_ip}:${target.host_port}`,
                            step_ms: +(performance.now() - t0).toFixed(2),
                        }, 'containerStateCheck_claim_done');
                        await cache.set(cacheKey, target);
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
                    return res.status(500).json({ error: "failed to start function instance" });
                }
            }
        }

        req.vmTarget = target.vmTarget || `http://${target.host_ip}:${target.host_port}`;
        req.containerId = target.container_id;
        req.log.info({
            elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
            functionName, vmTarget: req.vmTarget, step_ms: +(performance.now() - t0).toFixed(2),
        }, 'containerStateCheck_done');
        logger.info(`Function '${functionName}' routed to: ${req.vmTarget}`);
        next();
    } catch (err) {
        req.log.info({
            elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
            error: err.message,
        }, 'containerStateCheck_error');
        logger.error({ err }, 'Container State Check error');
        return res.status(500).json({ error: "internal error determining container state" });
    }
}
