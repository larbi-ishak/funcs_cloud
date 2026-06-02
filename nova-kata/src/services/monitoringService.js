const cron = require('node-cron');
const { workers } = require('../db/database');
const { checkWorkerHealth } = require('./workerService');
const logger = require('../utils/logger');

let task = null;

/**
 * Start the background monitoring loop.
 */
function startMonitoring() {
    const intervalMs = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS) || 30000;
    const intervalSec = Math.max(5, Math.floor(intervalMs / 1000));

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

async function runHealthCheckCycle() {
    const allWorkers = workers
        .findAll()
        .filter((w) => w.status !== 'retired');

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

    // ── Auto-scaling check ────────────────────────────────────────────────────
    // Skipped silently if GCP_PROJECT_ID is not set (GCP not configured).
    if (process.env.GCP_PROJECT_ID) {
        try {
            const { checkAndScale } = require('./scalingService');
            const result = await checkAndScale();
            if (result.triggered) {
                logger.info(`[AutoScale] Scale-out triggered — ${result.reason}`);
            } else {
                logger.debug(`[AutoScale] No action — ${result.reason}`);
            }
        } catch (err) {
            logger.error(`[AutoScale] checkAndScale error: ${err.message}`);
        }
    }
}

module.exports = { startMonitoring, stopMonitoring, runHealthCheckCycle };
