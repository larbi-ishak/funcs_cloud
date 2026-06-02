import cache from '../cache/cache.js';
import { containers } from '../db/database.js';
import axios from 'axios';
import logger from '../utils/logger.js';
import { logTiming } from '../utils/timingLogger.js';

const PLACEMENT_URL = process.env.PLACEMENT_SERVICE_URL || 'http://localhost:3002';

export default async function containerStateCheck(req, res, next) {
    const t0 = performance.now();
    const { functionData, functionName } = req;
    const cacheKey = `ct:${functionName}`;

    try {
        // ── Step 1: Check in-memory cache ─────────────────────────────────────
        let target = cache.get(cacheKey);

        if (target) {
            // Refresh the idle TTL — activity resets the 30s idle timer
            cache.ttl(cacheKey, parseInt(process.env.CONTAINER_IDLE_TTL) || 30);
            logTiming(req.requestId, 'containerStateCheck_cache_hit', performance.now() - req.startTime, {
                functionName, step_ms: +(performance.now() - t0).toFixed(2),
            });
        } else {
            logTiming(req.requestId, 'containerStateCheck_cache_miss', performance.now() - req.startTime, {
                functionName, step_ms: +(performance.now() - t0).toFixed(2),
            });

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
                };
                logTiming(req.requestId, 'containerStateCheck_db_hit', performance.now() - req.startTime, {
                    functionName, db_query_ms: dbElapsed, step_ms: +(performance.now() - t0).toFixed(2),
                });
                cache.set(cacheKey, target);
            } else {
                logTiming(req.requestId, 'containerStateCheck_db_miss', performance.now() - req.startTime, {
                    functionName, db_query_ms: dbElapsed, step_ms: +(performance.now() - t0).toFixed(2),
                });

                // ── Step 3: Claim from warm pool via Placement Service ────────
                logger.info(`Claiming warm container for ${functionName} — calling Nova Kata`);
                const tPlacement = performance.now();

                try {
                    const response = await axios.post(`${PLACEMENT_URL}/execute`, {
                        function_id: functionData.id,
                    });
                    const placementElapsed = +(performance.now() - tPlacement).toFixed(2);

                    if (response.data && response.data.success) {
                        const ct = response.data.container;
                        target = {
                            host_ip:      ct.host_ip || '127.0.0.1',
                            host_port:    ct.host_port || 9999,
                            container_id: ct.container_id,
                        };
                        logTiming(req.requestId, 'containerStateCheck_claim_done', performance.now() - req.startTime, {
                            functionName, placement_call_ms: placementElapsed,
                            source: ct.source, target: `${target.host_ip}:${target.host_port}`,
                            step_ms: +(performance.now() - t0).toFixed(2),
                        });
                        cache.set(cacheKey, target);
                    } else {
                        throw new Error("Placement service returned an error");
                    }
                } catch (error) {
                    const placementElapsed = +(performance.now() - tPlacement).toFixed(2);
                    logTiming(req.requestId, 'containerStateCheck_claim_failed', performance.now() - req.startTime, {
                        functionName, placement_call_ms: placementElapsed, error: error.message,
                    });
                    logger.error(`Failed to claim container for ${functionName}: ${error.message}`);
                    return res.status(500).json({ error: "failed to start function instance" });
                }
            }
        }

        req.vmTarget = `http://${target.host_ip}:${target.host_port}`;
        req.containerId = target.container_id;
        logTiming(req.requestId, 'containerStateCheck_done', performance.now() - req.startTime, {
            functionName, vmTarget: req.vmTarget, step_ms: +(performance.now() - t0).toFixed(2),
        });
        logger.info(`Function '${functionName}' routed to: ${req.vmTarget}`);
        next();
    } catch (err) {
        logTiming(req.requestId, 'containerStateCheck_error', performance.now() - req.startTime, {
            error: err.message,
        });
        logger.error(`Container State Check error: ${err.message}`);
        return res.status(500).json({ error: "internal error determining container state" });
    }
}
