const { v4: uuidv4 } = require('uuid');
const { workers, containers, events } = require('../db/database');
const { createInstance, deleteInstance } = require('./gcpService');
const { provisionWorker } = require('./provisionService');
const { initWorker } = require('./workerService');
const logger = require('../utils/logger');

// ── Configuration (from .env) ─────────────────────────────────────────────────
function cfg() {
    return {
        // Scale-out when cluster utilisation exceeds this fraction (0–1)
        scaleOutThreshold : parseFloat(process.env.SCALE_OUT_THRESHOLD)   || 0.75,
        // Max total workers in the cluster (cost guard)
        maxWorkers        : parseInt(process.env.MAX_WORKERS)              || 5,
        // Containers per worker capacity for utilisation calculation
        maxContainersPerWorker: parseInt(process.env.WARM_POOL_MAX)        || 10,
        // Minutes of cool-down between scale-out events
        coolDownMinutes   : parseFloat(process.env.SCALE_OUT_COOLDOWN_MIN) || 10,
        // Root password set on newly created GCP VMs
        rootPassword      : process.env.GCP_VM_ROOT_PASSWORD               || 'NovaWorker2025!',
        // SSH port on newly provisioned workers
        sshPort           : parseInt(process.env.GCP_VM_SSH_PORT)          || 22,
        // Default GCP region for auto-scaled workers
        defaultRegion     : process.env.GCP_DEFAULT_REGION                 || 'us',
    };
}

// ── In-memory state ───────────────────────────────────────────────────────────
let scalingInProgress = false;
let lastScaleOutAt    = null;   // Date | null

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute cluster-wide utilisation and decide whether to scale out.
 * Called automatically from monitoringService after each health cycle.
 *
 * @returns {{ triggered: boolean, reason: string, metrics?: object }}
 */
async function checkAndScale() {
    const metrics = getMetrics();

    // Guard: already scaling
    if (scalingInProgress) {
        return { triggered: false, reason: 'scaling_in_progress', metrics };
    }

    // Guard: cool-down
    if (lastScaleOutAt) {
        const minutesSince = (Date.now() - lastScaleOutAt.getTime()) / 60_000;
        if (minutesSince < cfg().coolDownMinutes) {
            return {
                triggered: false,
                reason   : `cooldown (${minutesSince.toFixed(1)}/${cfg().coolDownMinutes} min)`,
                metrics,
            };
        }
    }

    // Guard: max workers reached
    const healthyCount = metrics.healthyWorkers;
    const totalCount   = metrics.totalWorkers;
    if (totalCount >= cfg().maxWorkers) {
        return { triggered: false, reason: `max_workers_reached (${totalCount}/${cfg().maxWorkers})`, metrics };
    }

    // Decision: utilisation above threshold?
    if (metrics.utilisation < cfg().scaleOutThreshold) {
        return {
            triggered: false,
            reason   : `utilisation_ok (${(metrics.utilisation * 100).toFixed(1)}% < ${cfg().scaleOutThreshold * 100}%)`,
            metrics,
        };
    }

    logger.warn(
        `[AutoScale] Cluster at ${(metrics.utilisation * 100).toFixed(1)}% utilisation — scaling out...`
    );

    // Fire-and-forget (don't block the monitoring cycle)
    scaleOut({ region: cfg().defaultRegion }).catch(err =>
        logger.error(`[AutoScale] Scale-out failed: ${err.message}`)
    );

    return { triggered: true, reason: 'utilisation_above_threshold', metrics };
}

/**
 * Provision and register a new GCP worker.
 * Can be called manually (e.g. from an API route) or by checkAndScale().
 *
 * @param {object}   params
 * @param {string}   params.region       - Logical region id (e.g. 'europe')
 * @param {Function} [params.onLine]     - Optional log callback for SSE streaming
 * @returns {Promise<{ worker: object, instanceName: string, zone: string }>}
 */
async function scaleOut({ region, onLine } = {}) {
    if (scalingInProgress) {
        throw new Error('A scale-out operation is already in progress');
    }

    scalingInProgress = true;
    const log = (line) => {
        logger.info(`[AutoScale] ${line}`);
        if (typeof onLine === 'function') onLine(line);
    };

    try {
        const instanceName = `nova-worker-${uuidv4().split('-')[0]}`;
        const { rootPassword, sshPort } = cfg();

        // ── Phase 1: Create GCP VM ────────────────────────────────────────────
        log(`Creating GCP VM "${instanceName}" in region "${region}"...`);
        const { ip, zone } = await createInstance({
            region,
            instanceName,
            rootPassword,
        });
        log(`VM created. IP: ${ip}. Waiting for SSH to become ready...`);

        // ── Phase 2: Wait for SSH + sshd to be ready (startup script runs) ───
        await waitForSsh({ ip, username: 'root', password: rootPassword, port: sshPort, log });
        log('SSH is ready.');

        // ── Phase 3: Run provisioning (containerd, Kata, nerdctl, nginx…) ────
        log('Starting worker provisioning...');
        await provisionWorker({
            ip,
            username: 'root',
            password: rootPassword,
            ssh_port: sshPort,
            onLine  : log,
        });
        log('Provisioning complete.');

        // ── Phase 4: Validate + register in DB ───────────────────────────────
        log('Registering worker in database...');
        const worker = await initWorker({
            ip,
            username: 'root',
            password: rootPassword,
            ssh_port: sshPort,
        });

        // Store GCP-specific metadata on the worker row
        workers.setGcpMeta(worker.id, { instanceName, zone });

        events.insert({
            worker_id  : worker.id,
            event_type : 'auto_scaled',
            message    : `Auto-scaled from region ${region}. GCP instance: ${instanceName} (${zone})`,
        });

        lastScaleOutAt = new Date();

        log(`✅ Worker ${worker.id} (${ip}) registered and ready!`);
        logger.info(`[AutoScale] Scale-out complete. New worker: ${worker.id} (${ip})`);

        return { worker, instanceName, zone };

    } finally {
        scalingInProgress = false;
    }
}

/**
 * Terminate a GCP-backed worker: delete from DB + destroy the VM.
 *
 * @param {string} workerId
 */
async function scaleIn(workerId) {
    const worker = workers.findById(workerId);
    if (!worker) throw new Error(`Worker ${workerId} not found`);

    const { gcp_instance_name, gcp_zone } = worker;
    if (!gcp_instance_name || !gcp_zone) {
        throw new Error(`Worker ${workerId} was not created by the auto-scaler (no GCP metadata)`);
    }

    logger.info(`[AutoScale] Scaling in: deleting worker ${workerId} / VM ${gcp_instance_name}...`);

    // Mark worker retired first so it stops receiving traffic
    workers.updateStatus(workerId, 'retired');

    await deleteInstance({ instanceName: gcp_instance_name, zone: gcp_zone });

    workers.delete(workerId);
    logger.info(`[AutoScale] Worker ${workerId} removed and VM ${gcp_instance_name} deleted`);
}

// ── Metrics ───────────────────────────────────────────────────────────────────

/**
 * Compute current cluster load metrics.
 */
function getMetrics() {
    const all     = workers.findAll().filter(w => w.status !== 'retired');
    const healthy = all.filter(w => w.status === 'healthy');

    const maxContainersPerWorker = cfg().maxContainersPerWorker;
    const clusterCapacity = healthy.length * maxContainersPerWorker;

    const activeContainers = healthy.reduce(
        (sum, w) => sum + containers.countActiveByWorker(w.id),
        0
    );

    const utilisation = clusterCapacity > 0
        ? Math.min(1, activeContainers / clusterCapacity)
        : 0;

    return {
        totalWorkers          : all.length,
        healthyWorkers        : healthy.length,
        clusterCapacity,
        activeContainers,
        utilisation,
        thresholdToScaleOut   : cfg().scaleOutThreshold,
        maxWorkers            : cfg().maxWorkers,
        scalingInProgress,
        lastScaleOutAt        : lastScaleOutAt?.toISOString() || null,
    };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Retry SSH connection until it succeeds or times out.
 * The startup script needs ~30-60s to run after the VM boots.
 */
async function waitForSsh({ ip, username, password, port, log, timeoutMs = 5 * 60_000, retryMs = 10_000 }) {
    const { createSSHClient } = require('../utils/ssh');
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;

    while (Date.now() < deadline) {
        attempt++;
        try {
            const ssh = await createSSHClient({ ip, username, password, port });
            ssh.close();
            return; // success
        } catch {
            log(`SSH not ready yet (attempt ${attempt}) — retrying in ${retryMs / 1000}s...`);
            await sleep(retryMs);
        }
    }

    throw new Error(`SSH on ${ip}:${port} not available after ${timeoutMs / 1000}s`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { checkAndScale, scaleOut, scaleIn, getMetrics };
