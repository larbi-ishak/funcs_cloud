import 'dotenv/config';

import express from 'express';
import { v4 as uuidv4 } from 'uuid';

import { initDb, functions as functionsDb } from './db/database.js';
import cache from './cache/cache.js';
import parseHost from './middleware/parseHost.js';
import existenceCheck from './middleware/existenceCheck.js';
import authCheck from './middleware/authCheck.js';
import containerStateCheck from './middleware/containerStateCheck.js';
import forwardRequest from './proxy/forwardRequest.js';
import internalRoutes from './routes/internal.js';
import logger from './utils/logger.js';

// Global request ID + start-time middleware
const injectRequestId = (req, res, next) => {
    req.requestId = uuidv4();
    req.startTime = performance.now();
    req.log = logger.child({ requestId: req.requestId });
    req.log.info({ elapsed_ms: 0, method: req.method, url: req.url, host: req.headers.host }, 'request_received');
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
publicApp.use(parseHost);
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

    const publicServer = publicApp.listen(GATEWAY_PORT, '0.0.0.0', () => {
        logger.info(`Nova Kata Gateway (Public) listening on 0.0.0.0:${GATEWAY_PORT}`);
    });

    const internalServer = internalApp.listen(INTERNAL_PORT, '127.0.0.1', () => {
        logger.info(`Nova Kata Gateway (Internal) listening on 127.0.0.1:${INTERNAL_PORT}`);
    });

    const shutdown = () => {
        logger.info('Shutting down Gateway...');
        publicServer.close();
        internalServer.close();
        process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
})();
