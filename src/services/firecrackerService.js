const { v4: uuidv4 } = require('uuid');
const { createSSHClient } = require('../utils/ssh');
const { workers, microvms } = require('../db/database');
const logger = require('../utils/logger');
const { logTiming } = require('../utils/timingLogger');

/**
 * Launch a Firecracker MicroVM on a given worker.
 *
 * The Firecracker process is started on the remote VM via SSH.
 * Its API is then configured by sending commands through the unix socket
 * using `curl --unix-socket` executed remotely over SSH.
 *
 * @param {string} workerId
 * @param {object} options  - optional overrides: boot_args, metadata
 * @returns {object}  MicroVM record
 */
async function launchMicroVM(workerId, options = {}) {
    const t_launch = performance.now();
    const worker = workers.findById(workerId);
    if (!worker) throw new Error(`Worker ${workerId} not found`);
    if (worker.status !== 'healthy') {
        throw new Error(`Worker ${workerId} is not healthy (status: ${worker.status})`);
    }

    const vmId = uuidv4();
    const socketPath = `${worker.fc_socket_dir}/${vmId}.sock`;
    const logPrefix = `MicroVM[${vmId.slice(0, 8)}] on worker ${worker.ip}`;
    const rid = vmId.slice(0, 8); // short id for timing logs

    // ── Network Allocation ──────────────────────────────────────────────────
    const poolIndex = allocateVMPoolIndex(workerId);
    // Index i generates subnet 172.16.0.(i*4)/30
    const guestIpNum = (poolIndex * 4) + 2;
    const tapIpNum = (poolIndex * 4) + 1;
    const guestIp = `172.16.0.${guestIpNum}`;
    const tapIp = `172.16.0.${tapIpNum}`;
    const maskShort = `/30`;
    const tapDev = `tap${poolIndex}`;
    const macHex = guestIpNum.toString(16).padStart(2, '0').toUpperCase();
    const guestMac = `06:00:AC:10:00:${macHex}`;

    const hostPort = 8000 + poolIndex;
    const metadata = options.metadata || {};
    metadata.poolIndex = poolIndex;
    metadata.host_ip = worker.ip;
    metadata.host_port = hostPort;

    let bootArgs = options.boot_args || 'console=ttyS0 reboot=k panic=1 pci=off';
    if (!bootArgs.includes('ip=')) {
        bootArgs += ` ip=${guestIp}::${tapIp}:255.255.255.0:vm0:eth0:off`;
    }

    logger.info(`${logPrefix}: Launching (tap=${tapDev}, IP=${guestIp}, port=${hostPort})...`);
    logTiming(rid, 'launch_start', 0, { workerId, guestIp, tapDev, hostPort });

    // Persist initial record
    microvms.insert({
        id: vmId,
        worker_id: workerId,
        socket_path: socketPath,
        kernel_image_path: worker.kernel_image_path,
        rootfs_path: worker.rootfs_path,
        pid: null,
        status: 'starting',
        boot_args: bootArgs,
        metadata: JSON.stringify(metadata),
    });

    let ssh;
    try {
        // ── SSH Connect ──────────────────────────────────────────────────────
        const t_ssh = performance.now();
        ssh = await createSSHClient({
            ip: worker.ip,
            username: worker.username,
            password: worker.password,
            port: worker.ssh_port,
        });
        logTiming(rid, 'ssh_connect', performance.now() - t_launch, {
            worker_ip: worker.ip, step_ms: +(performance.now() - t_ssh).toFixed(2),
        });

        // ── Step 0: Setup Host Network Interface ─────────────────────────────
        const t_net = performance.now();
        const setupNetCmd = `
          sudo ip link del ${tapDev} 2>/dev/null || true;
          sudo ip tuntap add dev ${tapDev} mode tap;
          sudo ip addr add ${tapIp}${maskShort} dev ${tapDev};
          sudo ip link set dev ${tapDev} up;
        `.replace(/\n/g, ' ').trim();

        const netResult = await ssh.exec(setupNetCmd);
        if (netResult.code !== 0) {
            throw new Error(`Failed to configure network tap device: ${netResult.stderr || netResult.stdout}`);
        }
        logTiming(rid, 'tap_setup', performance.now() - t_launch, {
            tapDev, tapIp, step_ms: +(performance.now() - t_net).toFixed(2),
        });

        // ── Step 0.5: Setup Nginx reverse proxy ──────────────────────────────
        const t_nginx = performance.now();
        const nginxCmd = `
cat << 'EOF' | sudo tee /etc/nginx/conf.d/microvm-${vmId}.conf > /dev/null
server {
    listen ${hostPort};
    location / {
        proxy_pass http://${guestIp}:80;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
EOF
sudo nginx -s reload
`.trim();

        const nginxResult = await ssh.exec(nginxCmd);
        if (nginxResult.code !== 0) {
            throw new Error(`Failed to configure Nginx on worker: ${nginxResult.stderr || nginxResult.stdout}`);
        }
        logTiming(rid, 'nginx_setup', performance.now() - t_launch, {
            hostPort, guestIp, step_ms: +(performance.now() - t_nginx).toFixed(2),
        });

        // ── Step 1: Start Firecracker process in background ──────────────────
        const t_fcstart = performance.now();
        const pidFile = `/tmp/.fc-${vmId}.pid`;
        const startCmd =
            `nohup ${worker.firecracker_path} --api-sock ${socketPath} ` +
            `> /tmp/.fc-${vmId}.log 2>&1 & echo $! > ${pidFile}`;

        const startResult = await ssh.exec(startCmd);
        if (startResult.code !== 0) {
            throw new Error(`Failed to start Firecracker process: ${startResult.stderr}`);
        }
        logTiming(rid, 'fc_process_spawned', performance.now() - t_launch, {
            socketPath, step_ms: +(performance.now() - t_fcstart).toFixed(2),
        });

        // Give Firecracker a moment to create the socket
        const t_sleep = performance.now();
        await sleep(500);
        logTiming(rid, 'fc_socket_wait', performance.now() - t_launch, {
            waited_ms: +(performance.now() - t_sleep).toFixed(2),
        });

        // Read PID
        const t_pid = performance.now();
        const pidResult = await ssh.exec(`cat ${pidFile}`);
        const pid = parseInt(pidResult.stdout, 10) || null;
        logTiming(rid, 'fc_pid_read', performance.now() - t_launch, {
            pid, step_ms: +(performance.now() - t_pid).toFixed(2),
        });
        logger.debug(`${logPrefix}: PID=${pid}, socket=${socketPath}`);

        // Verify socket is actually there
        const t_sockcheck = performance.now();
        const sockCheck = await ssh.exec(`ls ${socketPath} 2>&1`);
        if (sockCheck.code !== 0) {
            throw new Error(`Firecracker socket not created at ${socketPath}. FC may have crashed.`);
        }
        logTiming(rid, 'fc_socket_verified', performance.now() - t_launch, {
            socketPath, step_ms: +(performance.now() - t_sockcheck).toFixed(2),
        });

        // ── Step 2: Configure boot source ───────────────────────────────────
        const bootSourcePayload = JSON.stringify({
            kernel_image_path: worker.kernel_image_path,
            boot_args: bootArgs,
        });
        await fcApiCallTimed(ssh, socketPath, 'PUT', '/boot-source', bootSourcePayload, logPrefix, rid, t_launch);

        // ── Step 3: Configure rootfs ────────────────────────────────────────
        const rootfsPayload = JSON.stringify({
            drive_id: 'rootfs',
            path_on_host: worker.rootfs_path,
            is_root_device: true,
            is_read_only: false,
        });
        await fcApiCallTimed(ssh, socketPath, 'PUT', '/drives/rootfs', rootfsPayload, logPrefix, rid, t_launch);

        // ── Step 3.5: Attach function drive ─────────────────────────────────
        const functionDrivePath = options.function_drive_path || '/root/lab2/function.ext4';
        const functionDrivePayload = JSON.stringify({
            drive_id: 'function',
            path_on_host: functionDrivePath,
            is_root_device: false,
            is_read_only: false,
        });
        await fcApiCallTimed(ssh, socketPath, 'PUT', '/drives/function', functionDrivePayload, logPrefix, rid, t_launch);

        // ── Step 3.6: Configure Network Interface ───────────────────────────
        const netIfacePayload = JSON.stringify({
            iface_id: 'eth0',
            guest_mac: guestMac,
            host_dev_name: tapDev,
        });
        await fcApiCallTimed(ssh, socketPath, 'PUT', '/network-interfaces/eth0', netIfacePayload, logPrefix, rid, t_launch);

        // ── Step 4: Start the MicroVM ────────────────────────────────────────
        const startActionPayload = JSON.stringify({ action_type: 'InstanceStart' });
        await fcApiCallTimed(ssh, socketPath, 'PUT', '/actions', startActionPayload, logPrefix, rid, t_launch);

        // ── Update DB ────────────────────────────────────────────────────────
        microvms.updateStatus(vmId, 'running', { pid });

        const totalMs = +(performance.now() - t_launch).toFixed(2);
        logTiming(rid, 'launch_complete', totalMs, { vmId, pid, total_ms: totalMs });
        logger.info(`${logPrefix}: MicroVM running (PID ${pid}) — total launch time: ${totalMs}ms`);

        return microvms.findById(vmId);
    } catch (err) {
        const totalMs = +(performance.now() - t_launch).toFixed(2);
        logTiming(rid, 'launch_failed', totalMs, { error: err.message, total_ms: totalMs });
        microvms.updateStatus(vmId, 'failed');
        logger.error(`${logPrefix}: Launch failed — ${err.message}`);
        throw err;
    } finally {
        if (ssh) ssh.close();
    }
}


/**
 * Stop a running MicroVM by killing its Firecracker process on the worker.
 * Uses the Firecracker API SendCtrlAltDel action, falling back to SIGTERM.
 *
 * @param {string} vmId
 */
async function stopMicroVM(vmId) {
    const vm = microvms.findById(vmId);
    if (!vm) throw new Error(`MicroVM ${vmId} not found`);
    if (['stopped', 'failed'].includes(vm.status)) {
        throw new Error(`MicroVM ${vmId} is already ${vm.status}`);
    }

    const worker = workers.findById(vm.worker_id);
    if (!worker) throw new Error(`Worker for MicroVM ${vmId} not found`);

    const logPrefix = `MicroVM[${vmId.slice(0, 8)}]`;
    logger.info(`${logPrefix}: Stopping...`);

    let ssh;
    try {
        ssh = await createSSHClient({
            ip: worker.ip,
            username: worker.username,
            password: worker.password,
            port: worker.ssh_port,
        });

        // Try graceful shutdown via Firecracker API
        try {
            const shutdownPayload = JSON.stringify({ action_type: 'SendCtrlAltDel' });
            await fcApiCall(ssh, vm.socket_path, 'PUT', '/actions', shutdownPayload, logPrefix);
            await sleep(2000);
        } catch (_) {
            // If API fails, fall back to killing the process
        }

        // Kill process if PID known
        if (vm.pid) {
            await ssh.exec(`kill -SIGTERM ${vm.pid} 2>/dev/null || true`);
        }

        // Clean up socket file
        await ssh.exec(`rm -f ${vm.socket_path}`);

        // Clean up tap device
        if (vm.metadata) {
            try {
                const meta = JSON.parse(vm.metadata);
                if (meta.poolIndex !== undefined) {
                    await ssh.exec(`sudo ip link del tap${meta.poolIndex} 2> /dev/null || true`);
                }
            } catch (e) { }
        }

        // Clean up Nginx config
        await ssh.exec(`sudo rm -f /etc/nginx/conf.d/microvm-${vmId}.conf && sudo nginx -s reload || true`);

        microvms.updateStatus(vmId, 'stopped');
        logger.info(`${logPrefix}: Stopped`);
    } finally {
        if (ssh) ssh.close();
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Make a Firecracker API call through the unix socket, executed via SSH.
 * Timed variant — records elapsed time for each call.
 */
async function fcApiCallTimed(ssh, socketPath, method, endpoint, body, logPrefix, rid, t_launch) {
    const t0 = performance.now();
    const httpCode = await fcApiCall(ssh, socketPath, method, endpoint, body, logPrefix);
    logTiming(rid, `fc_api_${endpoint.replace(/\//g, '_').replace(/^_/, '')}`, performance.now() - t_launch, {
        method, endpoint, httpCode, step_ms: +(performance.now() - t0).toFixed(2),
    });
    return httpCode;
}

/**
 * Make a Firecracker API call through the unix socket, executed via SSH.
 */
async function fcApiCall(ssh, socketPath, method, endpoint, body, logPrefix) {
    const cmd =
        `curl --unix-socket "${socketPath}" -s -o /tmp/.fc-resp -w "%{http_code}" ` +
        `-X ${method} 'http://localhost${endpoint}' ` +
        `-H 'Accept: application/json' ` +
        `-H 'Content-Type: application/json' ` +
        `-d '${body}'`;

    const result = await ssh.exec(cmd);
    const httpCode = parseInt(result.stdout, 10);

    if (isNaN(httpCode) || httpCode >= 300) {
        const respBody = (await ssh.exec('cat /tmp/.fc-resp 2>/dev/null')).stdout;
        throw new Error(
            `FC API ${method} ${endpoint} failed (HTTP ${httpCode}): ${respBody || result.stderr}`
        );
    }

    logger.debug(`${logPrefix}: FC API ${method} ${endpoint} → ${httpCode}`);
    return httpCode;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Allocate a unique /30 network pool index for a MicroVM on a specific worker.
 */
function allocateVMPoolIndex(workerId) {
    const activeVMs = microvms.findByWorker(workerId);
    const usedIndices = new Set();

    for (const vm of activeVMs) {
        if (vm.metadata) {
            try {
                const meta = JSON.parse(vm.metadata);
                if (meta.poolIndex !== undefined) usedIndices.add(meta.poolIndex);
            } catch (e) { }
        }
    }

    // Support up to 63 VMs per worker (gives guest IPs from .2 up to .254 in /30 ranges)
    for (let i = 0; i < 63; i++) {
        if (!usedIndices.has(i)) return i;
    }
    throw new Error('No network pool index available (maximum VMs reached per worker)');
}

module.exports = { launchMicroVM, stopMicroVM };
