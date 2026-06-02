import NodeCache from 'node-cache';
import axios from 'axios';

const PLACEMENT_URL = process.env.PLACEMENT_SERVICE_URL || 'http://localhost:3002';

// Hold each claimed container for 30s of idle time before returning it to the pool.
// This is the Lambda-style reuse window: same container serves multiple requests
// within 30s without re-claiming. After 30s idle, it's paused back into the warm pool.
const IDLE_TTL_SECONDS = parseInt(process.env.CONTAINER_IDLE_TTL) || 30;

const cache = new NodeCache({ stdTTL: IDLE_TTL_SECONDS, checkperiod: 10 });

// When a cache entry expires, release the container back to the warm pool
cache.on('expired', async (key, value) => {
    if (!value || !value.container_id) return;
    try {
        await axios.post(`${PLACEMENT_URL}/containers/${value.container_id}/release`);
    } catch (_) {
        // Best-effort — container may have already been removed / crashed
    }
});

export default cache;
