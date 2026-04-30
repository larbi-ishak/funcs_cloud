import cache from '../cache/cache.js';
import { vmInstances } from '../db/database.js';
import axios from 'axios';
import logger from '../utils/logger.js';
import { logTiming } from '../utils/timingLogger.js';

const PLACEMENT_URL = process.env.PLACEMENT_SERVICE_URL || 'http://localhost:3000';

export default async function vmStateCheck(req, res, next) {
    const t0 = performance.now();
    const { functionData, functionName } = req;
    const cacheKey = `vm:${functionName}`;

    try {
        // ── Step 1: Check in-memory cache ─────────────────────────────────────
        let vm = cache.get(cacheKey);

        if (vm) {
            logTiming(req.requestId, 'vmStateCheck_cache_hit', performance.now() - req.startTime, {
                functionName,
                step_ms: +(performance.now() - t0).toFixed(2),
            });
        } else {
            logTiming(req.requestId, 'vmStateCheck_cache_miss', performance.now() - req.startTime, {
                functionName,
                step_ms: +(performance.now() - t0).toFixed(2),
            });

            // ── Step 2: Query DB for a warm VM ─────────────────────────────────
            const tDb = performance.now();
            vm = vmInstances.findWarmVM(functionData.id);
            const dbElapsed = +(performance.now() - tDb).toFixed(2);

            if (vm) {
                logTiming(req.requestId, 'vmStateCheck_db_warm_hit', performance.now() - req.startTime, {
                    functionName,
                    db_query_ms: dbElapsed,
                    step_ms: +(performance.now() - t0).toFixed(2),
                });
                cache.set(cacheKey, vm, 5);
            } else {
                logTiming(req.requestId, 'vmStateCheck_db_warm_miss', performance.now() - req.startTime, {
                    functionName,
                    db_query_ms: dbElapsed,
                    step_ms: +(performance.now() - t0).toFixed(2),
                });

                // ── Step 3: Cold Start — call Placement Service ──────────────────
                logger.info(`Cold start for ${functionName} - calling Placement Service`);
                const tPlacement = performance.now();

                try {
                    const response = await axios.post(`${PLACEMENT_URL}/execute`, {
                        metadata: { function_id: functionData.id }
                    });

                    const placementElapsed = +(performance.now() - tPlacement).toFixed(2);

                    if (response.data && response.data.success) {
                        const microvm = response.data.microvm;

                        vm = {
                            host_ip: microvm.host_ip || '127.0.0.1',
                            host_port: microvm.host_port || 9999,
                        };

                        logTiming(req.requestId, 'vmStateCheck_cold_start_done', performance.now() - req.startTime, {
                            functionName,
                            placement_call_ms: placementElapsed,
                            vmTarget: `${vm.host_ip}:${vm.host_port}`,
                            step_ms: +(performance.now() - t0).toFixed(2),
                        });

                        cache.set(cacheKey, vm, 5);
                    } else {
                        logTiming(req.requestId, 'vmStateCheck_cold_start_failed', performance.now() - req.startTime, {
                            functionName,
                            placement_call_ms: placementElapsed,
                            reason: 'placement_returned_error',
                        });
                        throw new Error("Placement service returned an error");
                    }
                } catch (error) {
                    const placementElapsed = +(performance.now() - tPlacement).toFixed(2);
                    logTiming(req.requestId, 'vmStateCheck_cold_start_failed', performance.now() - req.startTime, {
                        functionName,
                        placement_call_ms: placementElapsed,
                        error: error.message,
                    });
                    logger.error(`Failed to trigger cold start for ${functionName}: ${error.message}`);
                    return res.status(500).json({ error: "failed to start function instance" });
                }
            }
        }

        req.vmTarget = `http://${vm.host_ip}:${vm.host_port}`;
        logTiming(req.requestId, 'vmStateCheck_done', performance.now() - req.startTime, {
            functionName,
            vmTarget: req.vmTarget,
            step_ms: +(performance.now() - t0).toFixed(2),
        });
        logger.info(`Function '${functionName}' routed to: ${req.vmTarget}`);
        next();
    } catch (err) {
        logTiming(req.requestId, 'vmStateCheck_error', performance.now() - req.startTime, {
            error: err.message,
        });
        logger.error(`VM State Check error: ${err.message}`);
        return res.status(500).json({ error: "internal error determining vm state" });
    }
}

