const { workers, microvms } = require('../db/database');
const logger = require('../utils/logger');

/**
 * Scheduler: pick the best available healthy worker for a new MicroVM.
 *
 * Strategy: least-loaded (fewest active MicroVMs).
 * Falls back to round-robin if all workers have the same load.
 *
 * @returns {object} worker record
 * @throws  if no healthy workers are available
 */
function pickWorker() {
    const healthyWorkers = workers.findHealthy();

    if (healthyWorkers.length === 0) {
        throw new Error('No healthy workers available in the pool');
    }

    // Annotate each with its active MicroVM count
    const annotated = healthyWorkers.map((w) => ({
        ...w,
        activeMicroVMs: microvms.countActiveByWorker(w.id),
    }));

    // Sort ascending by active MicroVM count
    annotated.sort((a, b) => a.activeMicroVMs - b.activeMicroVMs);

    const chosen = annotated[0];
    logger.debug(
        `Scheduler picked worker ${chosen.id} (${chosen.ip}) — ${chosen.activeMicroVMs} active MicroVMs`
    );

    return chosen;
}

/**
 * Return a summary of the worker pool.
 */
function getPoolMetrics() {
    const all = workers.findAll();

    const statusCounts = all.reduce((acc, w) => {
        acc[w.status] = (acc[w.status] || 0) + 1;
        return acc;
    }, {});

    const totalActive = all.reduce(
        (sum, w) => sum + microvms.countActiveByWorker(w.id),
        0
    );

    return {
        total_workers: all.length,
        by_status: statusCounts,
        total_active_microvms: totalActive,
    };
}

module.exports = { pickWorker, getPoolMetrics };
