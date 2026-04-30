import cache from '../cache/cache.js';
import { functions } from '../db/database.js';
import { logTiming } from '../utils/timingLogger.js';

export default function existenceCheck(req, res, next) {
    const t0 = performance.now();
    const { functionName, region } = req;
    const cacheKey = `fn:${functionName}`;
    
    // Check Cache
    let func = cache.get(cacheKey);
    const cacheHit = !!func;

    if (!func) {
        // Query DB
        func = functions.findByNameAndRegion(functionName, region);
        if (!func) {
            logTiming(req.requestId, 'existenceCheck_not_found', performance.now() - req.startTime, {
                functionName, region, step_ms: +(performance.now() - t0).toFixed(2),
            });
            return res.status(404).json({ error: "function not found" });
        }
        // Cache result (60s TTL)
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
        functionName,
        cacheHit,
        step_ms: +(performance.now() - t0).toFixed(2),
    });
    next();
}
