require('dotenv').config();

const express = require('express');
const { initDb } = require('./db/database');
const { startMonitoring } = require('./services/monitoringService');
const workersRouter = require('./routes/workers');
const containersRouter = require('./routes/containers');
const functionsRouter = require('./routes/functions');
const deployRouter = require('./routes/deploy');
const scalingRouter = require('./routes/scaling');
const logger = require('./utils/logger');

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '2mb' }));

// CORS (allow frontend dev servers)
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// Request logging middleware
app.use((req, res, next) => {
    logger.debug(`${req.method} ${req.path}`);
    next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/', deployRouter);       // /functions/deploy (SSE build + warm)
app.use('/', workersRouter);      // /init, /workers, /workers/:id, ...
app.use('/', containersRouter);   // /execute, /containers, /warm-pool, /metrics
app.use('/', functionsRouter);    // /functions, /functions/:id/keys
app.use('/', scalingRouter);      // /scaling/regions, /scaling/metrics, /scaling/scale-out

// ── Health endpoint ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    const mem = process.memoryUsage();
    res.json({
        status: 'ok',
        service: 'nova-kata',
        uptime: process.uptime(),
        memory: {
            heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
            rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
        },
        timestamp: new Date().toISOString(),
    });
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    logger.error(`Unhandled error: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3002;

(async () => {
    try {
        await initDb();
    } catch (err) {
        logger.error(`Failed to initialise database: ${err.message}`);
        process.exit(1);
    }

    const server = app.listen(PORT, () => {
        logger.info(`🚀 Nova Kata listening on http://localhost:${PORT}`);
        startMonitoring();
    });

    const shutdown = () => {
        logger.info('Shutting down...');
        server.close(() => {
            logger.info('HTTP server closed');
            process.exit(0);
        });
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    // Prevent unhandled promise rejections from crashing the process
    process.on('unhandledRejection', (reason) => {
        logger.error(`Unhandled rejection: ${reason}`);
    });
})();

module.exports = app;
