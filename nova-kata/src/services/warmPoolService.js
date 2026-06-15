const { workers, containers, warmPool, functions } = require('../db/database');
const { launchContainer, unpauseContainer } = require('./containerService');
const { pickWorker } = require('./schedulerService');
const logger = require('../utils/logger');

const WARM_POOL_MIN = parseInt(process.env.WARM_POOL_MIN) || 2;
const WARM_POOL_MAX = parseInt(process.env.WARM_POOL_MAX) || 10;

// Concurrency guard: prevents overlapping replenish cycles for the same function
const _replenishing = new Set();

/**
 * Claim a warm container for a request.
 *
 * Strategy:
 *  1. Look for a paused container in the warm pool (function-specific first, then generic)
 *  2. If found -> unpause it (near-instant) -> return it
 *  3. If none available -> launch a new container (cold start)
 *
 * After claiming, trigger background replenishment of the warm pool.
 */
async function claimWarmContainer(functionId) {
    // ── Try to claim from warm pool ──────────────────────────────────────────
    const warmEntry = warmPool.claimOne(functionId);

    if (warmEntry) {
        logger.info(`Warm pool: claimed container ${warmEntry.container_id} for function ${functionId || 'generic'}`);

        // Unpause it — if the worker is gone, discard the stale entry and fall through to cold start
        try {
            const container = await unpauseContainer(warmEntry.container_id);

            // Trigger background replenishment (non-blocking)
            setImmediate(() => replenishPool(functionId).catch(err => {
                logger.error(`Warm pool replenish failed: ${err.message}`);
            }));

            return {
                container_id: container.id,
                container_name: container.container_name,
                container_ip: container.container_ip,
                host_ip: _getHostIp(container),
                host_port: container.host_port,
                agent_port: container.agent_port,
                source: 'warm_pool',
            };
        } catch (err) {
            logger.warn(`Warm pool: container ${warmEntry.container_id} unusable (${err.message}) — discarding and cold starting`);
            // Clean up the stale warm pool entry and container record
            warmPool.deleteByContainer(warmEntry.container_id);
            const staleContainer = containers.findById(warmEntry.container_id);
            if (staleContainer) containers.updateStatus(warmEntry.container_id, 'failed');
            // Fall through to cold start below
        }
    }

    // ── No warm container available -> cold start ────────────────────────────
    logger.info(`Warm pool empty for function ${functionId || 'generic'} — cold starting`);

    const worker = pickWorker();
    const func = functionId ? functions.findById(functionId) : null;

    const container = await launchContainer(worker.id, {
        image: func ? func.image : undefined,
        agent_cmd: func ? func.agent_cmd : undefined,
        agent_port: func ? func.agent_port : undefined,
        env_vars: func && func.env_vars ? JSON.parse(func.env_vars) : undefined,
        memory_limit: func ? func.memory_limit : undefined,
        cpu_limit: func ? func.cpu_limit : undefined,
        storage_limit: func ? func.storage_limit : undefined,
        function_id: functionId,
        pause_after: false,
    });

    // Trigger background replenishment (non-blocking)
    setImmediate(() => replenishPool(functionId).catch(err => {
        logger.error(`Warm pool replenish failed: ${err.message}`);
    }));

    return {
        container_id: container.id,
        container_name: container.container_name,
        container_ip: container.container_ip,
        host_ip: _getHostIp(container),
        host_port: container.host_port,
        agent_port: container.agent_port,
        source: 'cold_start',
    };
}

/**
 * Replenish the warm pool to maintain the minimum number of paused containers.
 */
async function replenishPool(functionId) {
    // Concurrency guard: skip if already replenishing this function
    const key = functionId || '__generic__';
    if (_replenishing.has(key)) {
        logger.debug(`Warm pool: replenish already in progress for ${key} — skipping`);
        return;
    }
    _replenishing.add(key);

    try {
    const func = functionId ? functions.findById(functionId) : null;
    const minWarm = func && func.warm_count !== undefined ? func.warm_count : WARM_POOL_MIN;
    const maxContainers = func && func.max_containers !== undefined ? func.max_containers : WARM_POOL_MAX;

    const currentCount = warmPool.countWarm(functionId);
    const needed = minWarm - currentCount;

    if (needed <= 0) {
        logger.debug(`Warm pool: ${currentCount} warm, min=${minWarm} — no replenishment needed`);
        return;
    }

    const totalActiveForFunc = warmPool.findAll().filter(c => c.function_id === functionId).length;
    if (totalActiveForFunc >= maxContainers) {
        logger.debug(`Warm pool: at max capacity for function (${totalActiveForFunc}/${maxContainers}) — skipping`);
        return;
    }

    const toCreate = Math.min(needed, maxContainers - totalActiveForFunc);
    logger.info(`Warm pool: replenishing ${toCreate} containers for function ${functionId || 'generic'}`);

    for (let i = 0; i < toCreate; i++) {
        try {
            const worker = pickWorker();
            const container = await launchContainer(worker.id, {
                image: func ? func.image : undefined,
                agent_cmd: func ? func.agent_cmd : undefined,
                agent_port: func ? func.agent_port : undefined,
                env_vars: func && func.env_vars ? JSON.parse(func.env_vars) : undefined,
                memory_limit: func ? func.memory_limit : undefined,
                cpu_limit: func ? func.cpu_limit : undefined,
                storage_limit: func ? func.storage_limit : undefined,
                function_id: functionId,
                pause_after: true,
            });

            warmPool.insert({
                container_id: container.id,
                worker_id: worker.id,
                function_id: functionId || null,
                status: 'warm',
            });

            logger.info(`Warm pool: added container ${container.id.slice(0, 8)} (${i + 1}/${toCreate})`);
        } catch (err) {
            logger.error(`Warm pool: failed to create warm container (${i + 1}/${toCreate}): ${err.message}`);
        }
    }
    } finally {
        _replenishing.delete(key);
    }
}

/**
 * Get pool statistics.
 */
function getPoolStats() {
    const allWarm = warmPool.findAll();
    const warm = allWarm.filter(e => e.status === 'warm');
    const claimed = allWarm.filter(e => e.status === 'claimed');

    return {
        warm_count: warm.length,
        claimed_count: claimed.length,
        total: allWarm.length,
        min: WARM_POOL_MIN,
        max: WARM_POOL_MAX,
        entries: allWarm,
    };
}

function _getHostIp(container) {
    if (container.metadata) {
        try {
            const meta = JSON.parse(container.metadata);
            return meta.host_ip || null;
        } catch (_) { }
    }
    return null;
}

module.exports = { claimWarmContainer, replenishPool, getPoolStats };
