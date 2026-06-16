import cache from '../cache/cache.js';
import { functions } from '../db/database.js';

// Function metadata TTL — cached for a long time since it rarely changes.
// Invalidated explicitly via POST /internal/cache/invalidate when admin changes settings.
// Safety net: if invalidation fails, this TTL ensures eventual consistency.
const FUNCTION_CACHE_TTL = parseInt(process.env.FUNCTION_CACHE_TTL) || 3600; // default: 1 hour

export default async function existenceCheck(req, res, next) {
    const t0 = performance.now();
    const { functionName, region } = req;
    const cacheKey = `fn:${functionName}`;

    try {
        let func = await cache.get(cacheKey);
        const cacheHit = !!func;

        if (!func) {
            // Try exact match (name + region) first
            func = await functions.findByNameAndRegion(functionName, region);
            // Fallback: path-based routing doesn't know the region, match by name only
            if (!func) {
                func = await functions.findByName(functionName);
            }
            if (!func) {
                req.log.info({
                    elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
                    functionName, region, step_ms: +(performance.now() - t0).toFixed(2),
                }, 'existenceCheck_not_found');
                return res.status(404).json({ error: "function not found" });
            }
            await cache.set(cacheKey, func, FUNCTION_CACHE_TTL);
        }

        if (func.status !== 'active') {
            req.log.info({
                elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
                functionName, status: func.status, step_ms: +(performance.now() - t0).toFixed(2),
            }, 'existenceCheck_inactive');
            return res.status(404).json({ error: "function not available" });
        }

        req.functionData = func;

        req.log.info({
            elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
            functionName, cacheHit, step_ms: +(performance.now() - t0).toFixed(2),
        }, 'existenceCheck_done');
        next();
    } catch (err) {
        req.log.info({
            elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
            error: err.message,
        }, 'existenceCheck_error');
        return res.status(500).json({ error: "internal error checking function existence" });
    }
}
