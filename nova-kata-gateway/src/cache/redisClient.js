import Redis from 'ioredis';
import logger from '../utils/logger.js';

const REDIS_URL = process.env.REDIS_URL || '';

let redis = null;
let _isReady = false;

/**
 * Returns true when Redis is connected and ready for commands.
 * This is a function (not a static export) so cache.js can check
 * the current state at call time, not import time.
 */
export function isRedisReady() {
    return _isReady;
}

if (REDIS_URL) {
    redis = new Redis(REDIS_URL, {
        maxRetriesPerRequest: 3,
        retryStrategy(times) {
            if (times > 10) {
                logger.error('Redis: max retry attempts reached, giving up');
                return null;
            }
            const delay = Math.min(times * 200, 5000);
            logger.debug(`Redis: retrying connection in ${delay}ms (attempt ${times})`);
            return delay;
        },
        enableOfflineQueue: true,
        lazyConnect: true,
    });

    redis.on('connect', () => {
        _isReady = true;
        logger.info(`Connected to Redis at ${REDIS_URL.replace(/\/\/.*@/, '//***@')}`);
    });

    redis.on('ready', () => {
        _isReady = true;
    });

    redis.on('error', (err) => {
        // Suppress ECONNREFUSED errors during initial connection (expected when Redis isn't running)
        if (_isReady) {
            logger.error({ err }, 'Redis connection error');
        }
    });

    redis.on('close', () => {
        const wasReady = _isReady;
        _isReady = false;
        if (wasReady) {
            // Only warn if we were previously connected (not during retry attempts)
            logger.warn('Redis connection closed');
        }
    });

    redis.on('reconnecting', () => {
        _isReady = false;
        logger.debug('Redis reconnecting...');
    });

    // Attempt initial connection (non-blocking)
    redis.connect().catch((err) => {
        logger.error(`Redis: failed to connect — ${err.message}. Falling back to in-memory cache.`);
        _isReady = false;
    });

    // Graceful shutdown
    const shutdownRedis = () => {
        if (redis) {
            redis.quit().catch(() => {});
        }
    };
    process.on('SIGTERM', shutdownRedis);
    process.on('SIGINT', shutdownRedis);
} else {
    logger.info('REDIS_URL not set — using in-memory cache (node-cache)');
}

export { redis };