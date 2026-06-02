import express from 'express';
import cache from '../cache/cache.js';

const router = express.Router();

// POST /internal/invalidate
router.post('/invalidate', (req, res) => {
    const { key } = req.body;

    if (!key) {
        return res.status(400).json({ error: "missing key" });
    }

    cache.del(key);

    return res.json({ success: true });
});

export default router;
