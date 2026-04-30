const cron = require('node-cron');
const { workers } = require('../db/database');
const { checkWorkerHealth } = require('./workerService');
const logger = require('../utils/logger');

let task = null;

/**
 * Start the background monitoring loop.
 * Runs every HEALTH_CHECK_INTERVAL_MS milliseconds (default 30s).
 */
function startMonitoring() {
    const intervalMs = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS) || 30000;
    // Convert ms to seconds for cron (minimum every 5s)
    const intervalSec = Math.max(5, Math.floor(intervalMs / 1000));

    // node-cron uses cron syntax; for intervals < 60s we use a seconds-level expression
    const cronExpression =
        intervalSec < 60 ? `*/${intervalSec} * * * * *` : `0 */${Math.floor(intervalSec / 60)} * * * *`;

    logger.info(`Monitoring started (interval: ${intervalSec}s, cron: "${cronExpression}")`);

    task = cron.schedule(cronExpression, async () => {
        await runHealthCheckCycle();
    });
}

function stopMonitoring() {
    if (task) {
        task.stop();
        logger.info('Monitoring stopped');
    }
}

/**
 * Run one health-check pass across all non-retired workers.
 */
async function runHealthCheckCycle() {
    const allWorkers = workers
        .findAll()
        .filter((w) => !['retired', 'faulty'].includes(w.status));

    if (allWorkers.length === 0) return;

    logger.debug(`Health check cycle: ${allWorkers.length} worker(s) to check`);

    const results = await Promise.allSettled(
        allWorkers.map((w) =>
            checkWorkerHealth(w.id).catch((err) => ({
                healthy: false,
                reason: err.message,
            }))
        )
    );

    const healthy = results.filter(
        (r) => r.status === 'fulfilled' && r.value.healthy
    ).length;
    const unhealthy = allWorkers.length - healthy;

    if (unhealthy > 0) {
        logger.warn(`Health check: ${healthy}/${allWorkers.length} healthy, ${unhealthy} unhealthy`);
    } else {
        logger.debug(`Health check: all ${healthy} workers healthy`);
    }
}

module.exports = { startMonitoring, stopMonitoring, runHealthCheckCycle };
