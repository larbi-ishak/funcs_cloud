const { v4: uuidv4 } = require('uuid');
const { createSSHClient } = require('../utils/ssh');
const { workers, events } = require('../db/database');
const logger = require('../utils/logger');

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
        throw new InitError(`SSH connection failed: ${err.message}`, 'SSH_CONNECT_FAILED');
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
        workers.insert({
            id,
            ip,
            username,
            password,
            ssh_port,
            status: 'healthy',
        });

        events.insert({
            worker_id: id,
            event_type: 'init_success',
            message: `Validated. ${ctrVersion}`,
        });

        logger.info(`Worker ${ip} registered as ${id}`);
        const worker = workers.findById(id);
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
    const worker = workers.findById(workerId);
    if (!worker) throw new Error(`Worker ${workerId} not found`);

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

        workers.updateLastSeen(workerId);
        events.insert({ worker_id: workerId, event_type: 'health_ok', message: ping.stdout });

        return { healthy: true };
    } catch (err) {
        workers.incrementFailures(workerId);
        const fresh = workers.findById(workerId);
        const maxFails = parseInt(process.env.MAX_CONSECUTIVE_FAILURES) || 3;

        let newStatus = 'degraded';
        if (fresh.consecutive_failures >= maxFails) {
            newStatus = 'faulty';
            logger.warn(`Worker ${workerId} (${worker.ip}) marked FAULTY after ${fresh.consecutive_failures} failures`);
        }
        workers.updateStatus(workerId, newStatus);
        events.insert({ worker_id: workerId, event_type: 'health_fail', message: err.message });

        return { healthy: false, reason: err.message, status: newStatus };
    } finally {
        if (ssh) ssh.close();
    }
}

/**
 * Retire (mark faulty + optionally delete) a worker.
 */
function retireWorker(workerId, { remove = false } = {}) {
    const worker = workers.findById(workerId);
    if (!worker) throw new Error(`Worker ${workerId} not found`);

    workers.updateStatus(workerId, 'retired');
    events.insert({ worker_id: workerId, event_type: 'retired', message: 'Manually retired' });

    if (remove) {
        workers.delete(workerId);
        logger.info(`Worker ${workerId} deleted`);
    } else {
        logger.info(`Worker ${workerId} retired`);
    }
}

class InitError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'InitError';
        this.code = code;
    }
}

module.exports = { initWorker, checkWorkerHealth, retireWorker, InitError };
