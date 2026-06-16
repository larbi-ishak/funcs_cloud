const { v4: uuidv4 } = require('uuid');
const { createSSHClient } = require('../utils/ssh');
const { workers, containers, warmPool, events } = require('../db/database');
const { encrypt } = require('../utils/crypto');
const logger = require('../utils/logger');
const axios = require('axios');
const http = require('http');

// ── Worker API client for health checks ────────────────────────────────────
const WORKER_API_KEY = process.env.WORKER_API_KEY || 'nova-worker-default-key';
const WORKER_API_PORT = parseInt(process.env.WORKER_API_PORT) || 3005;
const workerApiClient = axios.create({
    httpAgent: new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 10 }),
    timeout: 5000,
    headers: { 'X-Worker-Key': WORKER_API_KEY },
});

/**
 * Validates and registers a new worker VM.
 *
 * Steps:
 *  1. SSH connection test
 *  2. containerd check (ctr version)
 *  3. nerdctl check
 *  4. Kata runtime check (containerd-shim-kata-v2)
 *  5. Persist to DB
 */
async function initWorker(params) {
    const {
        ip,
        username,
        password,
        ssh_port = 22,
    } = params;

    logger.info(`Initialising worker ${ip}...`);

    let ssh;

    // ── 1. SSH Connection ──────────────────────────────────────────────────────
    try {
        ssh = await createSSHClient({ ip, username, password, port: ssh_port });
    } catch (err) {
        // Register as PENDING — health check will retry validation
        const id = uuidv4();
        await workers.insert({ id, ip, username, password: encrypt(password), ssh_port, status: 'pending' });
        await events.insert({
            worker_id: id,
            event_type: 'init_pending',
            message: `SSH failed: ${err.message}. Registered as pending — health check will retry.`,
        });
        logger.warn(`Worker ${ip} registered as PENDING (SSH failed: ${err.message})`);
        const worker = await workers.findById(id);
        const { password: _, ...safe } = worker;
        return safe;
    }

    try {
        // ── 2. Containerd check ──────────────────────────────────────────────────
        const ctrCheck = await ssh.exec('ctr version 2>&1');
        if (ctrCheck.code !== 0) {
            throw new InitError(
                `containerd not available: ${ctrCheck.stdout}`,
                'CONTAINERD_MISSING'
            );
        }
        const ctrVersion = ctrCheck.stdout.split('\n')[0];
        logger.info(`Worker ${ip}: ${ctrVersion}`);

        // ── 3. nerdctl check ─────────────────────────────────────────────────────
        const nerdctlCheck = await ssh.exec('nerdctl version 2>&1');
        if (nerdctlCheck.code !== 0) {
            throw new InitError(
                `nerdctl not available: ${nerdctlCheck.stdout}`,
                'NERDCTL_MISSING'
            );
        }
        logger.info(`Worker ${ip}: nerdctl available`);

        // ── 4. Kata runtime check ────────────────────────────────────────────────
        const kataCheck = await ssh.exec('ls /usr/local/bin/containerd-shim-kata-v2 2>&1 || ls /opt/kata/bin/containerd-shim-kata-v2 2>&1');
        if (kataCheck.code !== 0) {
            throw new InitError(
                `Kata runtime shim not found: ${kataCheck.stdout}`,
                'KATA_RUNTIME_MISSING'
            );
        }
        logger.info(`Worker ${ip}: Kata runtime shim found`);

        // ── 5. Check CNI plugins ─────────────────────────────────────────────────
        const cniCheck = await ssh.exec('ls /opt/cni/bin/bridge 2>&1');
        if (cniCheck.code !== 0) {
            logger.warn(`Worker ${ip}: CNI plugins may not be installed at /opt/cni/bin`);
        }

        // ── 6. Persist ───────────────────────────────────────────────────────────
        const id = uuidv4();
        await workers.insert({
            id,
            ip,
            username,
            password: encrypt(password),
            ssh_port,
            status: 'healthy',
        });

        await events.insert({
            worker_id: id,
            event_type: 'init_success',
            message: `Validated. ${ctrVersion}`,
        });

        logger.info(`Worker ${ip} registered as ${id}`);
        const worker = await workers.findById(id);
        // Don't return password
        const { password: _, ...safe } = worker;
        return safe;

    } catch (err) {
        if (err instanceof InitError) throw err;
        throw new InitError(err.message, 'UNKNOWN');
    } finally {
        ssh.close();
    }
}

/**
 * Perform a health check on a single worker (SSH ping + containerd check).
 * Updates DB accordingly. Returns { healthy: bool, reason? }
 */
async function checkWorkerHealth(workerId) {
    const worker = await workers.findById(workerId);
    if (!worker) throw new Error(`Worker ${workerId} not found`);

    // ── Try Worker API first (no SSH handshake) ─────────────────────────────
    // Skip for pending workers — they need full SSH validation (nerdctl, kata)
    if (worker.status !== 'pending') {
        try {
            const response = await workerApiClient.get(
                `http://${worker.ip}:${WORKER_API_PORT}/health`
            );

            if (response.data && response.data.containerd_ok) {
                // Worker API reports healthy — no SSH needed
                await workers.updateLastSeen(workerId);
                await events.insert({
                    worker_id: workerId,
                    event_type: 'health_ok',
                    message: response.data.uptime_cmd || 'ok (via Worker API)',
                });
                return { healthy: true, via: 'worker_api' };
            }

            // containerd not ok — fall through to SSH for auto-recovery
            logger.warn(`Worker ${workerId} containerd not ok via Worker API — falling back to SSH for recovery`);
        } catch (apiErr) {
            logger.debug(`Worker ${workerId} Worker API health failed (${apiErr.message}) — falling back to SSH`);
        }
    }

    // ── Fallback: SSH health check ──────────────────────────────────────────
    let ssh;
    try {
        ssh = await createSSHClient({
            ip: worker.ip,
            username: worker.username,
            password: worker.password,
            port: worker.ssh_port,
        });

        // Simple uptime ping
        const ping = await ssh.exec('uptime');
        if (ping.code !== 0) throw new Error('uptime command failed');

        // containerd still running?
        const ctrCheck = await ssh.exec('ctr version 2>&1', 5000);
        if (ctrCheck.code !== 0) {
            logger.warn(`Worker ${workerId} containerd check failed. Attempting auto-recovery (systemctl restart containerd)...`);
            // Attempt to restart the daemon
            await ssh.exec('sudo systemctl restart containerd', 15000);
            
            // Re-check after restart
            const retryCheck = await ssh.exec('ctr version 2>&1', 5000);
            if (retryCheck.code !== 0) {
                throw new Error('containerd not responding even after auto-recovery restart');
            } else {
                logger.info(`Worker ${workerId} containerd auto-recovered successfully.`);
                // We don't throw here, we let the health check pass since it recovered
            }
        }

        // If worker was PENDING, do full validation before marking healthy
        if (worker.status === 'pending') {
            logger.info(`Worker ${workerId} was PENDING — running full validation...`);

            const nerdctlCheck = await ssh.exec('nerdctl version 2>&1');
            if (nerdctlCheck.code !== 0) {
                throw new Error('nerdctl not available (pending validation failed)');
            }

            const kataCheck = await ssh.exec('ls /usr/local/bin/containerd-shim-kata-v2 2>&1 || ls /opt/kata/bin/containerd-shim-kata-v2 2>&1');
            if (kataCheck.code !== 0) {
                throw new Error('Kata runtime shim not found (pending validation failed)');
            }

            logger.info(`Worker ${workerId} (${worker.ip}) validation passed — marking HEALTHY`);
            await workers.updateStatus(workerId, 'healthy');
        }

        await workers.updateLastSeen(workerId);
        await events.insert({ worker_id: workerId, event_type: 'health_ok', message: ping.stdout });

        return { healthy: true, via: 'ssh' };
    } catch (err) {
        await workers.incrementFailures(workerId);
        const fresh = await workers.findById(workerId);
        if (!fresh) return { healthy: false, reason: 'Worker deleted during health check' };

        const maxFails = parseInt(process.env.MAX_CONSECUTIVE_FAILURES) || 3;
        const recoveryMaxFails = parseInt(process.env.WORKER_RECOVERY_MAX_FAILURES) || 10;

        if (fresh.consecutive_failures >= maxFails && fresh.consecutive_failures < recoveryMaxFails) {
            // Grace period: mark as faulty but keep trying
            if (fresh.status !== 'faulty') {
                await workers.updateStatus(workerId, 'faulty');
                logger.warn(`Worker ${workerId} (${worker.ip}) marked FAULTY after ${fresh.consecutive_failures} failures — will keep retrying (up to ${recoveryMaxFails})`);
                await events.insert({ worker_id: workerId, event_type: 'health_faulty', message: `Marked faulty after ${fresh.consecutive_failures} failures: ${err.message}` });
            } else {
                logger.debug(`Worker ${workerId} still faulty (${fresh.consecutive_failures}/${recoveryMaxFails} failures) — retrying`);
            }
            return { healthy: false, reason: err.message, status: 'faulty' };
        }

        if (fresh.consecutive_failures >= recoveryMaxFails) {
            // Recovery exhausted: retire and clean up
            await warmPool.removeByWorkerId(workerId);
            await containers.removeByWorkerId(workerId);
            await workers.updateStatus(workerId, 'retired');
            logger.warn(`Worker ${workerId} (${worker.ip}) RETIRED after ${fresh.consecutive_failures} consecutive failures (recovery exhausted)`);
            await events.insert({ worker_id: workerId, event_type: 'worker_retired', message: `Auto-retired after ${fresh.consecutive_failures} failures (recovery max: ${recoveryMaxFails}): ${err.message}` });

            // Notify gateway to invalidate its container cache
            try {
                const { invalidateGatewayCache } = require('./monitoringService');
                invalidateGatewayCache(); // async, non-blocking
            } catch (_) {}

            return { healthy: false, reason: err.message, status: 'retired' };
        }

        // Below maxFails: mark degraded
        let newStatus = fresh.status === 'pending' ? 'pending' : 'degraded';
        await workers.updateStatus(workerId, newStatus);
        await events.insert({ worker_id: workerId, event_type: 'health_fail', message: err.message });

        return { healthy: false, reason: err.message, status: newStatus };
    } finally {
        if (ssh) ssh.close();
    }
}

/**
 * Retire (mark faulty + optionally delete) a worker.
 */
async function retireWorker(workerId, { remove = false } = {}) {
    const worker = await workers.findById(workerId);
    if (!worker) throw new Error(`Worker ${workerId} not found`);

    // Always clean up warm pool entries for retired workers
    await warmPool.removeByWorkerId(workerId);

    await workers.updateStatus(workerId, 'retired');
    await events.insert({ worker_id: workerId, event_type: 'retired', message: 'Manually retired' });

    if (remove) {
        // Cascade: remove containers for this worker
        await containers.removeByWorkerId(workerId);
        await workers.delete(workerId);
        logger.info(`Worker ${workerId} deleted (warm pool + containers cleaned up)`);
    } else {
        logger.info(`Worker ${workerId} retired (warm pool cleaned up)`);
    }
}

class InitError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'InitError';
        this.code = code;
    }
}

/**
 * Reset a worker's failure count and status, then immediately health-check it.
 * Used for manual retry after fixing a faulty/retired worker.
 */
async function resetAndRetryWorker(workerId) {
    const worker = await workers.findById(workerId);
    if (!worker) throw new Error(`Worker ${workerId} not found`);

    logger.info(`Manual retry requested for worker ${workerId} (${worker.ip}) — resetting failures`);

    // Reset failures and mark as pending so health check will validate
    await workers.resetFailures(workerId);
    await workers.updateStatus(workerId, 'pending');

    // Immediately run health check
    const result = await checkWorkerHealth(workerId);
    return result;
}

module.exports = { initWorker, checkWorkerHealth, retireWorker, resetAndRetryWorker, InitError };
