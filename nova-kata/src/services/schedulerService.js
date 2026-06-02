const { workers, containers } = require('../db/database');
const logger = require('../utils/logger');

/**
 * Scheduler: pick the best available healthy worker for a new container.
 * Strategy: least-loaded (fewest active containers).
 */
function pickWorker() {
    const healthyWorkers = workers.findHealthy();

    if (healthyWorkers.length === 0) {
        throw new Error('No healthy workers available in the pool');
    }

    const annotated = healthyWorkers.map((w) => ({
        ...w,
        activeContainers: containers.countActiveByWorker(w.id),
    }));

    annotated.sort((a, b) => a.activeContainers - b.activeContainers);

    const chosen = annotated[0];
    logger.debug(
        `Scheduler picked worker ${chosen.id} (${chosen.ip}) — ${chosen.activeContainers} active containers`
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
        (sum, w) => sum + containers.countActiveByWorker(w.id),
        0
    );

    return {
        total_workers: all.length,
        by_status: statusCounts,
        total_active_containers: totalActive,
    };
}

module.exports = { pickWorker, getPoolMetrics };
