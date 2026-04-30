import 'dotenv/config';

import express from 'express';
import { v4 as uuidv4 } from 'uuid';

import { initDb } from './db/database.js';
import parseHost from './middleware/parseHost.js';
import existenceCheck from './middleware/existenceCheck.js';
import authCheck from './middleware/authCheck.js';
import vmStateCheck from './middleware/vmStateCheck.js';
import forwardRequest from './proxy/forwardRequest.js';
import internalRoutes from './routes/internal.js';
import logger from './utils/logger.js';
import { logTiming } from './utils/timingLogger.js';

// Global request ID + start-time middleware
const injectRequestId = (req, res, next) => {
    req.requestId = uuidv4();
    req.startTime = performance.now();
    logTiming(req.requestId, 'request_received', 0, { method: req.method, url: req.url, host: req.headers.host });
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
publicApp.use(parseHost);
publicApp.use(existenceCheck);
publicApp.use(authCheck);
publicApp.use(vmStateCheck);
publicApp.use(forwardRequest);

// Global Error Handler
publicApp.use((err, req, res, next) => {
    logger.error(`Public wrapper Unhandled error: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
});

// ── Internal Server (Control plane) ───────────────────────────────────────
const internalApp = express();
internalApp.use(express.json()); // internal API uses JSON body
internalApp.use(injectRequestId);
internalApp.use(wrapResponse);

internalApp.use('/internal', internalRoutes);

internalApp.use((err, req, res, next) => {
    logger.error(`Internal wrapper Unhandled error: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
});

// ── Startup ───────────────────────────────────────────────────────────────
const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT) || 8080;
const INTERNAL_PORT = parseInt(process.env.INTERNAL_PORT) || 3001;

(async () => {
    try {
        await initDb();
    } catch (err) {
        logger.error(`Failed to initialise database: ${err.message}`);
        process.exit(1);
    }

    const publicServer = publicApp.listen(GATEWAY_PORT, '0.0.0.0', () => {
        logger.info(`🌐 Nova Gateway (Public) listening on 0.0.0.0:${GATEWAY_PORT}`);
    });

    const internalServer = internalApp.listen(INTERNAL_PORT, '127.0.0.1', () => {
        logger.info(`🔒 Nova Gateway (Internal) listening on 127.0.0.1:${INTERNAL_PORT}`);
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

