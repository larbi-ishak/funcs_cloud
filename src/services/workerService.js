const { v4: uuidv4 } = require('uuid');
const { createSSHClient } = require('../utils/ssh');
const { workers, events } = require('../db/database');
const logger = require('../utils/logger');

/**
 * Validates and registers a new worker VM.
 *
 * Steps:
 *  1. SSH connection test
 *  2. Firecracker binary check (exists + version)
 *  3. Kernel image + rootfs file check
 *  4. Firecracker socket directory setup
 *  5. Persist to DB
 */
async function initWorker(params) {
    const {
        ip,
        username,
        password,
        ssh_port = 22,
        firecracker_path = process.env.DEFAULT_FIRECRACKER_PATH || '/usr/local/bin/firecracker',
        kernel_image_path = process.env.DEFAULT_KERNEL_IMAGE_PATH || '/root/lab/hello-vmlinux.bin',
        rootfs_path = process.env.DEFAULT_ROOTFS_PATH || '/root/lab2/hello-rootfs.ext4',
        fc_socket_dir = process.env.FC_SOCKET_DIR || '/tmp/fc-sockets',
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
        // ── 2. Firecracker binary ────────────────────────────────────────────────
        const binaryCheck = await ssh.exec(`ls ${firecracker_path} 2>&1`);
        if (binaryCheck.code !== 0) {
            throw new InitError(
                `Firecracker binary not found at ${firecracker_path}: ${binaryCheck.stdout}`,
                'FC_BINARY_MISSING'
            );
        }

        const versionCheck = await ssh.exec(`${firecracker_path} --version 2>&1`);
        if (versionCheck.code !== 0) {
            throw new InitError(
                `Firecracker binary not executable: ${versionCheck.stdout}`,
                'FC_BINARY_NOT_EXECUTABLE'
            );
        }
        const fcVersion = versionCheck.stdout.split('\n')[0];
        logger.info(`Worker ${ip}: Firecracker ${fcVersion}`);

        // ── 3. Kernel image ──────────────────────────────────────────────────────
        const kernelCheck = await ssh.exec(`ls ${kernel_image_path} 2>&1`);
        if (kernelCheck.code !== 0) {
            throw new InitError(
                `Kernel image not found at ${kernel_image_path}: ${kernelCheck.stdout}`,
                'KERNEL_IMAGE_MISSING'
            );
        }

        // ── 4. rootfs ────────────────────────────────────────────────────────────
        const rootfsCheck = await ssh.exec(`ls ${rootfs_path} 2>&1`);
        if (rootfsCheck.code !== 0) {
            throw new InitError(
                `rootfs not found at ${rootfs_path}: ${rootfsCheck.stdout}`,
                'ROOTFS_MISSING'
            );
        }

        // ── 5. Ensure socket directory exists ─────────────────────────────────
        await ssh.exec(`mkdir -p ${fc_socket_dir}`);

        // ── 6. Persist ───────────────────────────────────────────────────────────
        const id = uuidv4();
        workers.insert({
            id,
            ip,
            username,
            password,
            ssh_port,
            firecracker_path,
            kernel_image_path,
            rootfs_path,
            fc_socket_dir,
            status: 'healthy',
        });

        events.insert({
            worker_id: id,
            event_type: 'init_success',
            message: `Validated. FC: ${fcVersion}`,
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
 * Perform a health check on a single worker (SSH ping + binary check).
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

        // Binary still present?
        const binCheck = await ssh.exec(`ls ${worker.firecracker_path}`);
        if (binCheck.code !== 0) throw new Error(`Firecracker binary missing`);

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
