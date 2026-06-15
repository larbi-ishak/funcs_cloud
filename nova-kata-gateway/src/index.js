import 'dotenv/config';

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import rateLimit from 'express-rate-limit';
import compression from 'compression';

import { initDb, functions as functionsDb, containers as containersDb } from './db/database.js';
import cache from './cache/cache.js';
import parseHost from './middleware/parseHost.js';
import existenceCheck from './middleware/existenceCheck.js';
import authCheck from './middleware/authCheck.js';
import containerStateCheck from './middleware/containerStateCheck.js';
import forwardRequest from './proxy/forwardRequest.js';
import internalRoutes from './routes/internal.js';
import logger from './utils/logger.js';
import { register, rateLimited } from './utils/metrics.js';

// Global request ID + start-time middleware
const injectRequestId = (req, res, next) => {
    req.requestId = uuidv4();
    req.startTime = performance.now();
    req.log = logger.child({ requestId: req.requestId });
    // Skip logging for high-frequency polling endpoints to reduce noise
    if (req.url !== '/metrics' && req.url !== '/health') {
        req.log.info({ elapsed_ms: 0, method: req.method, url: req.url, host: req.headers.host }, 'request_received');
    }
    next();
};

// Wrap res.json to automatically inject request_id into error responses
const wrapResponse = (req, res, next) => {
    const originalJson = res.json;
    res.json = function(body) {
        if (body && body.error && !body.request_id) {
            body.request_id = req.requestId;
        }
        return originalJson.call(this, body);
    };
    next();
};

// ── Public Server (Gateway) ───────────────────────────────────────────────
const publicApp = express();
publicApp.use(injectRequestId);
publicApp.use(wrapResponse);

// ── Item 16: Request timeout middleware ────────────────────────────────────
// Safety net: kill any request that exceeds the global timeout.
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS) || 60000;
publicApp.use((req, res, next) => {
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        if (!res.headersSent) {
            res.status(504).json({ error: 'Request timeout', request_id: req.requestId });
        }
    });
    next();
});

// ── Item 11: Rate Limiting ─────────────────────────────────────────────────
// Per-IP rate limit: prevents any single client from overwhelming the gateway.
const ipLimiter = rateLimit({
    windowMs: 1000,
    max: parseInt(process.env.RATE_LIMIT_PER_SEC) || 100,
    standardHeaders: true,   // Return rate limit info in `RateLimit-*` headers
    legacyHeaders: false,    // Disable `X-RateLimit-*` headers
    handler: (req, res) => {
        rateLimited.labels('ip').inc();
        res.status(429).json({ error: 'Too many requests', request_id: req.requestId });
    },
});
publicApp.use(ipLimiter);

// ── Item 15: Compress proxy responses ──────────────────────────────────────
// Only compress non-proxied responses >1KB. Proxied responses are left to
// the backend container to decide (avoids double-compression).
publicApp.use(compression({
    threshold: 1024,
    filter: (req, res) => {
        if (req.vmTarget) return false;  // don't compress proxied responses
        return compression.filter(req, res);
    },
}));

// CORS — allow browser-based clients (dashboard, frontend apps)
publicApp.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');
        res.setHeader('Access-Control-Max-Age', '86400'); // 24h preflight cache
    }
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    next();
});

// Health check endpoint (before parseHost so it doesn't need /fn/ prefix)
publicApp.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        cache: { isRedis: cache.isRedis },
    });
});

// Pipeline
publicApp.use((req, res, next) => {
    // Ignore common browser background requests to prevent false invocations
    if (req.url === '/favicon.ico' || 
        req.url.startsWith('/.well-known/') || 
        req.url === '/robots.txt' || 
        req.url.includes('apple-touch-icon')) {
        return res.status(204).end();
    }
    next();
});
// Per-function rate limit: applied after parseHost (when functionName is known)
const functionLimiter = rateLimit({
    windowMs: 1000,
    max: parseInt(process.env.FUNCTION_RATE_LIMIT) || 50,
    keyGenerator: (req) => req.functionName || req.ip,
    handler: (req, res) => {
        rateLimited.labels('function').inc();
        res.status(429).json({ error: 'Function rate limit exceeded', request_id: req.requestId });
    },
});

publicApp.use(parseHost);
publicApp.use(functionLimiter);
publicApp.use(existenceCheck);
publicApp.use(authCheck);
publicApp.use(containerStateCheck);
publicApp.use(forwardRequest);

// Global Error Handler
publicApp.use((err, req, res, next) => {
    logger.error({ stack: err.stack }, `Public Unhandled error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
});

// ── Internal Server (Control plane) ───────────────────────────────────────
const internalApp = express();
internalApp.use(express.json());
internalApp.use(injectRequestId);
internalApp.use(wrapResponse);

// ── Item 14: /metrics endpoint (Prometheus) ────────────────────────────────
internalApp.get('/metrics', async (req, res) => {
    try {
        res.set('Content-Type', register.contentType);
        res.end(await register.metrics());
    } catch (err) {
        res.status(500).json({ error: 'Failed to collect metrics' });
    }
});

internalApp.use('/internal', internalRoutes);

internalApp.use((err, req, res, next) => {
    logger.error({ stack: err.stack }, `Internal Unhandled error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
});

// ── Startup ───────────────────────────────────────────────────────────────
const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT) || 8081;
const INTERNAL_PORT = parseInt(process.env.INTERNAL_PORT) || 3003;

(async () => {
    try {
        await initDb();
    } catch (err) {
        logger.error(`Failed to initialise database: ${err.message}`);
        process.exit(1);
    }

    // ── Pre-warm function cache ────────────────────────────────────────────
    // Load all functions into cache on startup so first requests are cache hits.
    try {
        const FUNCTION_CACHE_TTL = parseInt(process.env.FUNCTION_CACHE_TTL) || 3600;
        const allFunctions = functionsDb.findAll();
        for (const fn of allFunctions) {
            await cache.set(`fn:${fn.name}`, fn, FUNCTION_CACHE_TTL);
        }
        logger.info(`Pre-warmed cache with ${allFunctions.length} functions`);
    } catch (err) {
        logger.warn(`Failed to pre-warm function cache: ${err.message}`);
        // Non-fatal — first requests will just be cache misses
    }

    // ── Item 13: Pre-warm container cache ───────────────────────────────────
    // Load running containers per function into cache so first requests after
    // restart are cache hits (avoid ~5ms DB query penalty on first request).
    try {
        const CONTAINER_CACHE_TTL = parseInt(process.env.CONTAINER_CACHE_TTL) || 300;
        const allFunctions = functionsDb.findAll();
        let warmedContainers = 0;
        for (const fn of allFunctions) {
            const running = containersDb.findAllRunningByFunction(fn.id);
            if (running.length > 0) {
                const containerEntries = running
                    .filter(c => c.container_ip || (c.metadata && (() => { try { return JSON.parse(c.metadata).host_ip; } catch(_) { return null; } })()))
                    .map(c => {
                        let hostIp = c.container_ip;
                        try { const meta = JSON.parse(c.metadata); hostIp = meta.host_ip || hostIp; } catch (_) {}
                        return {
                            host_ip: hostIp,
                            host_port: c.host_port,
                            container_id: c.id,
                            vmTarget: `http://${hostIp}:${c.host_port}`,
                        };
                    });
                if (containerEntries.length > 0) {
                    await cache.set(`ct:${fn.name}`, { containers: containerEntries, nextIndex: 0 }, CONTAINER_CACHE_TTL);
                    warmedContainers += containerEntries.length;
                }
            }
        }
        logger.info(`Pre-warmed container cache: ${warmedContainers} containers across ${allFunctions.length} functions`);
    } catch (err) {
        logger.warn(`Failed to pre-warm container cache: ${err.message}`);
        // Non-fatal — first requests will just be cache misses
    }

    const publicServer = publicApp.listen(GATEWAY_PORT, '0.0.0.0', () => {
        logger.info(`Nova Kata Gateway (Public) listening on 0.0.0.0:${GATEWAY_PORT}`);
    });

    const INTERNAL_HOST = process.env.INTERNAL_HOST || '127.0.0.1';
    const internalServer = internalApp.listen(INTERNAL_PORT, INTERNAL_HOST, () => {
        logger.info(`Nova Kata Gateway (Internal) listening on ${INTERNAL_HOST}:${INTERNAL_PORT}`);
    });

    // ── Graceful shutdown with connection draining ──────────────────────────
    const connections = new Set();
    const trackConnections = (server) => {
        server.on('connection', (conn) => {
            connections.add(conn);
            conn.on('close', () => connections.delete(conn));
        });
    };
    trackConnections(publicServer);
    trackConnections(internalServer);

    const DRAIN_TIMEOUT_MS = 10000;

    const shutdown = () => {
        logger.info('Shutting down Gateway — draining connections...');
        publicServer.close();   // stop accepting new connections
        internalServer.close();

        // Flush invocation buffer before exiting
        try {
            const { default: forwardRequest } = require('./proxy/forwardRequest.js');
        } catch (_) {}

        const forceExit = setTimeout(() => {
            logger.warn(`Forcing exit after ${DRAIN_TIMEOUT_MS}ms — ${connections.size} connections still active`);
            process.exit(1);
        }, DRAIN_TIMEOUT_MS);

        // Wait for all in-flight connections to close
        const drainPromises = [...connections].map(
            conn => new Promise(resolve => conn.on('close', resolve))
        );
        Promise.all(drainPromises).then(() => {
            clearTimeout(forceExit);
            logger.info('All connections drained — exiting');
            process.exit(0);
        });
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
})();
