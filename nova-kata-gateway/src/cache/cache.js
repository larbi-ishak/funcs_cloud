import NodeCache from 'node-cache';
import axios from 'axios';
import logger from '../utils/logger.js';
import { redis, isRedisReady } from './redisClient.js';

const PLACEMENT_URL = process.env.PLACEMENT_SERVICE_URL || 'http://localhost:3002';
const IDLE_TTL_SECONDS = parseInt(process.env.CONTAINER_IDLE_TTL) || 30;
const EXPIRY_CHECK_INTERVAL_MS = 10_000; // same as node-cache checkperiod: 10

// ── Expiry handler ────────────────────────────────────────────────────────
let expiryHandler = null;

async function releaseContainer(key, value) {
    if (!value || !value.container_id) return;
    try {
        await axios.post(`${PLACEMENT_URL}/containers/${value.container_id}/release`);
        logger.info({ container_id: value.container_id, key }, 'Container released (cache expired)');
    } catch (_) {
        // Best-effort — container may have already been removed / crashed
    }
}

async function handleExpiry(key, value) {
    if (expiryHandler) {
        await expiryHandler(key, value);
    } else if (key.startsWith('ct:')) {
        await releaseContainer(key, value);
    }
}

// ── Local node-cache (always available as fallback) ───────────────────────
const nodeCache = new NodeCache({ stdTTL: IDLE_TTL_SECONDS, checkperiod: 10 });

nodeCache.on('expired', async (key, value) => {
    await handleExpiry(key, value);
});

// ── Redis expiry tracking (sorted set) ────────────────────────────────────
const EXPIRY_ZSET = 'cache:container_expirations';
let expiryChecker = null;

function startRedisExpiryChecker() {
    if (expiryChecker) return; // already running

    expiryChecker = setInterval(async () => {
        if (!redis || !isRedisReady()) return;

        try {
            const now = Date.now();
            const expired = await redis.zrangebyscore(EXPIRY_ZSET, 0, now);

            for (const key of expired) {
                // Remove from sorted set first (prevent double-processing)
                await redis.zrem(EXPIRY_ZSET, key);

                // Check if key still exists in Redis (may have been refreshed)
                const ttl = await redis.ttl(key);
                if (ttl > 0) {
                    // Key was refreshed — re-schedule and skip
                    await redis.zadd(EXPIRY_ZSET, now + (ttl * 1000), key);
                    continue;
                }

                // Key has truly expired — get data and fire handler
                const raw = await redis.get(key);
                if (raw) {
                    try {
                        const value = JSON.parse(raw);
                        await handleExpiry(key, value);
                    } catch (parseErr) {
                        logger.warn({ key }, 'Cache: failed to parse expired Redis entry');
                    }
                }
            }
        } catch (err) {
            logger.error({ err }, 'Cache: Redis expiry check failed');
        }
    }, EXPIRY_CHECK_INTERVAL_MS);

    // Don't prevent process exit
    if (expiryChecker.unref) expiryChecker.unref();
}

// Start Redis expiry checker if Redis is configured
if (redis) {
    startRedisExpiryChecker();
}

// ── Unified Cache API ─────────────────────────────────────────────────────
// Routes to Redis when available, falls back to node-cache otherwise.
// Middleware uses the same cache.get/set/ttl/on interface regardless of backend.

const cache = {
    /**
     * Get a cached value by key.
     * @returns {Promise<any|undefined>}
     */
    async get(key) {
        if (redis && isRedisReady()) {
            try {
                const raw = await redis.get(key);
                if (raw === null) return undefined;
                return JSON.parse(raw);
            } catch (err) {
                logger.warn({ key, err: err.message }, 'Cache: Redis GET failed, falling back to node-cache');
                // Fall through to node-cache
            }
        }

        // Fallback: node-cache (always available as hot standby)
        const value = nodeCache.get(key);
        return value !== undefined ? value : undefined;
    },

    /**
     * Set a cached value with optional TTL (seconds).
     * @returns {Promise<void>}
     */
    async set(key, value, ttlSeconds) {
        const ttl = ttlSeconds || IDLE_TTL_SECONDS;

        // ── Always write to node-cache (hot standby for seamless Redis failover) ──
        if (ttlSeconds) {
            nodeCache.set(key, value, ttlSeconds);
        } else {
            nodeCache.set(key, value);
        }

        // ── Also write to Redis if available (shared across instances) ──
        if (redis && isRedisReady()) {
            try {
                await redis.set(key, JSON.stringify(value), 'EX', ttl);

                // Track container keys in sorted set for expiry handling
                if (key.startsWith('ct:') && value && value.container_id) {
                    await redis.zadd(EXPIRY_ZSET, Date.now() + (ttl * 1000), key);
                }
            } catch (err) {
                logger.warn({ key, err: err.message }, 'Cache: Redis SET failed, node-cache already updated');
            }
        }
    },

    /**
     * Refresh the TTL of an existing key.
     * @returns {Promise<void>}
     */
    async ttl(key, ttlSeconds) {
        const ttl = ttlSeconds || IDLE_TTL_SECONDS;

        // ── Always refresh node-cache (hot standby) ──
        nodeCache.ttl(key, ttl);

        // ── Also refresh Redis if available ──
        if (redis && isRedisReady()) {
            try {
                await redis.expire(key, ttl);

                // Update expiry schedule for container keys
                if (key.startsWith('ct:')) {
                    await redis.zadd(EXPIRY_ZSET, Date.now() + (ttl * 1000), key);
                }
            } catch (err) {
                logger.warn({ key, err: err.message }, 'Cache: Redis EXPIRE failed, node-cache already refreshed');
            }
        }
    },

    /**
     * Register an expiry handler.
     */
    on(event, handler) {
        if (event === 'expired') {
            expiryHandler = handler;
        }
    },

    /**
     * Delete a key from the cache.
     * @returns {Promise<void>}
     */
    async del(key) {
        // ── Always delete from node-cache ──
        nodeCache.del(key);

        // ── Also delete from Redis if available ──
        if (redis && isRedisReady()) {
            try {
                await redis.del(key);
                if (key.startsWith('ct:')) {
                    await redis.zrem(EXPIRY_ZSET, key);
                }
            } catch (err) {
                logger.warn({ key, err: err.message }, 'Cache: Redis DEL failed, node-cache already deleted');
            }
        }
    },

    /**
     * Delete all cache entries matching a key prefix.
     * Used for bulk invalidation (e.g., all function metadata after a bulk update).
     * @param {string} prefix - Key prefix to match (e.g., "fn:" or "ct:")
     * @returns {Promise<number>} Number of keys deleted
     */
    async deleteByPrefix(prefix) {
        let count = 0;

        // ── Delete from node-cache ──
        const nodeKeys = nodeCache.keys().filter(k => k.startsWith(prefix));
        if (nodeKeys.length > 0) {
            nodeCache.del(nodeKeys);
            count += nodeKeys.length;
        }

        // ── Delete from Redis if available ──
        if (redis && isRedisReady()) {
            try {
                // Use SCAN to find matching keys (non-blocking, production-safe)
                let cursor = '0';
                do {
                    const [nextCursor, keys] = await redis.scan(
                        cursor, 'MATCH', `${prefix}*`, 'COUNT', 100
                    );
                    cursor = nextCursor;
                    if (keys.length > 0) {
                        await redis.del(...keys);
                        // Also remove from expiry sorted set
                        const ctKeys = keys.filter(k => k.startsWith('ct:'));
                        if (ctKeys.length > 0) {
                            await redis.zrem(EXPIRY_ZSET, ...ctKeys);
                        }
                        count += keys.length;
                    }
                } while (cursor !== '0');
            } catch (err) {
                logger.warn({ prefix, err: err.message }, 'Cache: Redis SCAN/DEL by prefix failed');
            }
        }

        return count;
    },

    /**
     * Returns true when actively using Redis backend.
     */
    get isRedis() {
        return !!(redis && isRedisReady());
    },
};

export default cache;