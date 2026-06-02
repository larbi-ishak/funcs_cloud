import cache from '../cache/cache.js';
import { functions } from '../db/database.js';
import { logTiming } from '../utils/timingLogger.js';

export default function existenceCheck(req, res, next) {
    const t0 = performance.now();
    const { functionName, region } = req;
    const cacheKey = `fn:${functionName}`;

    let func = cache.get(cacheKey);
    const cacheHit = !!func;

    if (!func) {
        // Try exact match (name + region) first
        func = functions.findByNameAndRegion(functionName, region);
        // Fallback: path-based routing doesn't know the region, match by name only
        if (!func) {
            func = functions.findByName(functionName);
        }
        if (!func) {
            logTiming(req.requestId, 'existenceCheck_not_found', performance.now() - req.startTime, {
                functionName, region, step_ms: +(performance.now() - t0).toFixed(2),
            });
            return res.status(404).json({ error: "function not found" });
        }
        cache.set(cacheKey, func, 60);
    }

    if (func.status !== 'active') {
        logTiming(req.requestId, 'existenceCheck_inactive', performance.now() - req.startTime, {
            functionName, status: func.status, step_ms: +(performance.now() - t0).toFixed(2),
        });
        return res.status(404).json({ error: "function not available" });
    }

    req.functionData = func;

    logTiming(req.requestId, 'existenceCheck_done', performance.now() - req.startTime, {
        functionName, cacheHit, step_ms: +(performance.now() - t0).toFixed(2),
    });
    next();
}
