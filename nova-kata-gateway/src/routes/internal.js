import express from 'express';
import cache from '../cache/cache.js';
import logger from '../utils/logger.js';

const router = express.Router();

// POST /internal/invalidate
//
// Invalidate cache entries. Called by admin/placement service when function
// metadata changes (auth policy, status, config, etc.).
//
// Body:
//   { "key": "fn:my-function" }        — invalidate a specific key
//   { "prefix": "fn:" }                — invalidate all keys with a prefix
//   { "prefix": "fn:", "key": "..." }  — both (key takes priority)
//
// Examples:
//   POST /internal/invalidate  { "key": "fn:pay-fn" }
//     → Deletes the pay-fn function metadata cache entry
//
//   POST /internal/invalidate  { "prefix": "fn:" }
//     → Deletes ALL function metadata cache entries (e.g., after bulk update)
//
//   POST /internal/invalidate  { "prefix": "ct:" }
//     → Deletes ALL container state cache entries (e.g., after deployment)
//
router.post('/invalidate', async (req, res) => {
    const { key, prefix } = req.body;

    try {
        if (key) {
            // Invalidate a specific key
            await cache.del(key);
            logger.info({ key }, 'Cache entry invalidated');
            return res.json({ success: true, invalidated: key });
        }

        if (prefix) {
            // Invalidate all keys matching a prefix
            const count = await cache.deleteByPrefix(prefix);
            logger.info({ prefix, count }, 'Cache entries invalidated by prefix');
            return res.json({ success: true, invalidated_prefix: prefix, count });
        }

        return res.status(400).json({
            error: 'missing key or prefix',
            hint: 'Send { "key": "fn:my-fn" } or { "prefix": "fn:" }',
        });
    } catch (err) {
        logger.error({ err, key, prefix }, 'Cache invalidation failed');
        return res.status(500).json({ error: 'invalidation failed' });
    }
});

export default router;