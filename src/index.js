require('dotenv').config();

const express = require('express');
const { initDb } = require('./db/database');
const { startMonitoring } = require('./services/monitoringService');
const workersRouter = require('./routes/workers');
const microvmsRouter = require('./routes/microvms');
const logger = require('./utils/logger');

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
    logger.debug(`${req.method} ${req.path}`);
    next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/', workersRouter);    // /init, /workers, /workers/:id, ...
app.use('/', microvmsRouter);   // /execute, /microvms, /metrics

// ── Health endpoint ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'placement-nova', timestamp: new Date().toISOString() });
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

// ── Start (async so we can await the sql.js DB init) ──────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;

(async () => {
    try {
        await initDb();
    } catch (err) {
        logger.error(`Failed to initialise database: ${err.message}`);
        process.exit(1);
    }

    const server = app.listen(PORT, () => {
        logger.info(`🚀 Placement Nova listening on http://localhost:${PORT}`);
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
})();

module.exports = app;
