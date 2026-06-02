const { v4: uuidv4 } = require('uuid');
const { createSSHClient } = require('../utils/ssh');
const { workers, containers, warmPool } = require('../db/database');
const logger = require('../utils/logger');
const { logTiming } = require('../utils/timingLogger');

const DEFAULT_IMAGE = process.env.DEFAULT_IMAGE || 'localhost:5000/nova-fn-hello:latest';
const DEFAULT_RUNTIME = process.env.DEFAULT_RUNTIME || 'io.containerd.kata.v2';
const DEFAULT_SNAPSHOTTER = process.env.DEFAULT_SNAPSHOTTER || 'overlayfs';
const DEFAULT_AGENT_CMD = process.env.DEFAULT_AGENT_CMD || 'python3 /nova_agent.py';
const DEFAULT_AGENT_PORT = parseInt(process.env.DEFAULT_AGENT_PORT) || 8080;

/**
 * Launch a new container via nerdctl on a worker.
 *
 * Uses the Kata QEMU runtime. Each container gets its own IP via CNI
 * networking (nerdctl handles this automatically). We discover the IP
 * with `nerdctl inspect` and configure nginx to proxy to it.
 *
 * @param {string} workerId
 * @param {object} options - image, env_vars, function_id, agent_cmd, agent_port, pause_after
 * @returns {object} container record
 */
async function launchContainer(workerId, options = {}) {
    const t_launch = performance.now();
    const worker = workers.findById(workerId);
    if (!worker) throw new Error(`Worker ${workerId} not found`);
    if (worker.status !== 'healthy') {
        throw new Error(`Worker ${workerId} is not healthy (status: ${worker.status})`);
    }

    const containerId = uuidv4();
    const containerName = `nova-${containerId.slice(0, 12)}`;
    const rid = containerId.slice(0, 8);
    const logPrefix = `Container[${rid}] on worker ${worker.ip}`;

    const image = options.image || DEFAULT_IMAGE;
    const runtime = options.runtime || DEFAULT_RUNTIME;
    const agentCmd = options.agent_cmd || DEFAULT_AGENT_CMD;
    const agentPort = options.agent_port || DEFAULT_AGENT_PORT;
    const envVars = options.env_vars || {};
    const functionId = options.function_id || null;
    const pauseAfter = options.pause_after || false;

    // Allocate a host port from the pool
    const poolIndex = allocatePoolIndex(workerId);
    const hostPort = 9000 + poolIndex;

    const metadata = {
        poolIndex,
        host_ip: worker.ip,
        host_port: hostPort,
    };

    logger.info(`${logPrefix}: Launching container (image=${image}, port=${hostPort})...`);
    logTiming(rid, 'launch_start', 0, { workerId, containerName, image, hostPort });

    containers.insert({
        id: containerId,
        worker_id: workerId,
        container_name: containerName,
        image,
        runtime,
        container_ip: null,
        host_port: hostPort,
        agent_port: agentPort,
        status: 'creating',
        function_id: functionId,
        metadata: JSON.stringify(metadata),
    });

    const envFlags = [`--env NOVA_PORT=${agentPort}`];
    if (envVars && typeof envVars === 'object') {
        for (const [k, v] of Object.entries(envVars)) {
            envFlags.push(`--env ${k}=${v}`);
        }
    }

    const memoryLimit = options.memory_limit ? `--memory ${options.memory_limit}m` : '';
    const cpuLimit = options.cpu_limit ? `--cpus ${options.cpu_limit}` : '';

    const launchScript = `#!/usr/bin/env bash
set -euo pipefail

# ── 1. Run container with Kata QEMU runtime ──────────────────────────────────
# Note: no command is passed — the image's CMD is used directly.
# This avoids the ENTRYPOINT+args confusion when cached images have stale entrypoints.
nerdctl run \\
  --runtime ${runtime} \\
  --snapshotter ${DEFAULT_SNAPSHOTTER} \\
  ${memoryLimit} \\
  ${cpuLimit} \\
  ${envFlags.join(' \\\n  ')} \\
  -d \\
  --name ${containerName} \\
  ${image}

# ── 2. Get container IP (retry loop — Kata VMs need time to boot) ────────────
CONTAINER_IP=""
for i in $(seq 1 15); do
    sleep 1
    # Try primary format first
    CONTAINER_IP=$(nerdctl inspect ${containerName} --format '{{.NetworkSettings.IPAddress}}' 2>/dev/null || echo "")
    # Fallback: grep raw JSON
    if [ -z "$CONTAINER_IP" ]; then
        CONTAINER_IP=$(nerdctl inspect ${containerName} 2>/dev/null | grep -oP '"IPAddress":\\s*"\\K[^"]+' | grep -v '^$' | head -1 || echo "")
    fi
    # Check if container is still running (exit early if it crashed)
    CONTAINER_STATE=$(nerdctl inspect ${containerName} --format '{{.State.Status}}' 2>/dev/null || echo "unknown")
    if [ "$CONTAINER_STATE" = "exited" ] || [ "$CONTAINER_STATE" = "dead" ]; then
        LOGS=$(nerdctl logs ${containerName} 2>&1 | tail -20 || echo "no logs")
        echo "{\"error\":\"container exited unexpectedly\",\"logs\":\"$LOGS\"}" >&2
        exit 1
    fi
    if [ -n "$CONTAINER_IP" ]; then
        break
    fi
done

if [ -z "$CONTAINER_IP" ]; then
    echo '{"error":"could not determine container IP after 15s"}' >&2
    exit 1
fi

# ── 3. Add nginx reverse proxy config ────────────────────────────────────────
cat > /etc/nginx/conf.d/nova-${containerName}.conf <<NGINXEOF
server {
    listen ${hostPort};
    location / {
        proxy_pass http://$CONTAINER_IP:${agentPort};
        proxy_set_header Host \\$host;
        proxy_set_header X-Real-IP \\$remote_addr;
        proxy_set_header X-Forwarded-For \\$proxy_add_x_forwarded_for;
    }
}
NGINXEOF
nginx -s reload 2>/dev/null || true

# ── 4. Optionally pause for warm pool ────────────────────────────────────────
${pauseAfter ? `sleep 2\nnerdctl pause ${containerName}` : '# not pausing'}

printf '{"container_ip":"%s","host_port":${hostPort},"status":"ok"}\\n' "$CONTAINER_IP"
`;

    let ssh;
    try {
        const t_ssh = performance.now();
        ssh = await createSSHClient({
            ip: worker.ip, username: worker.username,
            password: worker.password, port: worker.ssh_port,
        });
        logTiming(rid, 'ssh_connect', performance.now() - t_launch, {
            worker_ip: worker.ip, step_ms: +(performance.now() - t_ssh).toFixed(2),
        });

        const t_script = performance.now();
        const encoded = Buffer.from(launchScript).toString('base64');
        // 90s timeout: Kata VM boot can take 5-15s, and nerdctl pause can hang if daemon is busy
        const result = await ssh.exec(`echo '${encoded}' | base64 -d | bash`, 90000);

        if (result.code !== 0) {
            throw new Error(`Launch script failed (exit ${result.code}): ${result.stderr || result.stdout || '(no output)'}`);
        }

        logTiming(rid, 'container_started', performance.now() - t_launch, {
            step_ms: +(performance.now() - t_script).toFixed(2),
        });

        // Parse output for container IP
        let containerIp = null;
        try {
            const lastLine = result.stdout.trim().split('\n').pop();
            const parsed = JSON.parse(lastLine);
            containerIp = parsed.container_ip || null;
        } catch (_) {
            logger.warn(`${logPrefix}: Could not parse script output: ${result.stdout}`);
        }

        const status = pauseAfter ? 'paused' : 'running';
        containers.updateStatus(containerId, status, {
            container_ip: containerIp,
            host_port: hostPort,
        });

        const totalMs = +(performance.now() - t_launch).toFixed(2);
        logTiming(rid, 'launch_complete', totalMs, { containerId, containerIp, total_ms: totalMs });
        logger.info(`${logPrefix}: Container started (IP ${containerIp}) — ${totalMs}ms`);

        return containers.findById(containerId);

    } catch (err) {
        const totalMs = +(performance.now() - t_launch).toFixed(2);
        logTiming(rid, 'launch_failed', totalMs, { error: err.message, total_ms: totalMs });
        containers.updateStatus(containerId, 'failed');
        logger.error(`${logPrefix}: Launch failed — ${err.message}`);
        throw err;
    } finally {
        if (ssh) ssh.close();
    }
}

/**
 * Unpause a paused container (from warm pool).
 * Near-instant resume — this is the "all warm" strategy.
 */
async function unpauseContainer(containerId) {
    const container = containers.findById(containerId);
    if (!container) throw new Error(`Container ${containerId} not found`);
    if (container.status !== 'paused') {
        throw new Error(`Container ${containerId} is not paused (status: ${container.status})`);
    }

    const worker = workers.findById(container.worker_id);
    if (!worker) throw new Error(`Worker for container ${containerId} not found`);

    const t0 = performance.now();
    const rid = containerId.slice(0, 8);
    const logPrefix = `Container[${rid}]`;

    logger.info(`${logPrefix}: Unpausing...`);
    logTiming(rid, 'unpause_start', 0, { containerId, containerName: container.container_name });

    let ssh;
    try {
        ssh = await createSSHClient({
            ip: worker.ip, username: worker.username,
            password: worker.password, port: worker.ssh_port,
        });

        const result = await ssh.exec(`nerdctl unpause ${container.container_name}`);
        if (result.code !== 0) {
            throw new Error(`Unpause failed: ${result.stderr || result.stdout}`);
        }

        containers.updateStatus(containerId, 'running');

        const totalMs = +(performance.now() - t0).toFixed(2);
        logTiming(rid, 'unpause_complete', totalMs, { total_ms: totalMs });
        logger.info(`${logPrefix}: Unpaused — ${totalMs}ms`);

        return containers.findById(containerId);

    } catch (err) {
        logger.error(`${logPrefix}: Unpause failed — ${err.message}`);
        throw err;
    } finally {
        if (ssh) ssh.close();
    }
}

/**
 * Pause a running container (move to warm pool).
 */
async function pauseContainer(containerId) {
    const container = containers.findById(containerId);
    if (!container) throw new Error(`Container ${containerId} not found`);
    if (container.status !== 'running') {
        throw new Error(`Container ${containerId} is not running (status: ${container.status})`);
    }

    const worker = workers.findById(container.worker_id);
    if (!worker) throw new Error(`Worker for container ${containerId} not found`);

    const logPrefix = `Container[${containerId.slice(0, 8)}]`;
    logger.info(`${logPrefix}: Pausing...`);

    let ssh;
    try {
        ssh = await createSSHClient({
            ip: worker.ip, username: worker.username,
            password: worker.password, port: worker.ssh_port,
        });

        const result = await ssh.exec(`nerdctl pause ${container.container_name}`);
        if (result.code !== 0) {
            throw new Error(`Pause failed: ${result.stderr || result.stdout}`);
        }

        containers.updateStatus(containerId, 'paused');
        logger.info(`${logPrefix}: Paused`);

    } finally {
        if (ssh) ssh.close();
    }
}

/**
 * Stop and remove a container.
 */
async function stopContainer(containerId) {
    const container = containers.findById(containerId);
    if (!container) throw new Error(`Container ${containerId} not found`);
    if (['stopped', 'failed'].includes(container.status)) {
        throw new Error(`Container ${containerId} is already ${container.status}`);
    }

    const worker = workers.findById(container.worker_id);
    if (!worker) throw new Error(`Worker for container ${containerId} not found`);

    const logPrefix = `Container[${containerId.slice(0, 8)}]`;
    logger.info(`${logPrefix}: Stopping...`);

    const stopScript = `#!/usr/bin/env bash
set -uo pipefail

# ── 1. Unpause if paused (nerdctl rm requires running or stopped) ─────────────
nerdctl unpause ${container.container_name} 2>/dev/null || true

# ── 2. Stop and remove container ──────────────────────────────────────────────
nerdctl stop ${container.container_name} 2>/dev/null || true
nerdctl rm -f ${container.container_name} 2>/dev/null || true

# ── 3. Remove nginx config and reload ─────────────────────────────────────────
rm -f /etc/nginx/conf.d/nova-${container.container_name}.conf
nginx -s reload 2>/dev/null || true

echo '{"status":"stopped"}'
`;

    let ssh;
    try {
        ssh = await createSSHClient({
            ip: worker.ip, username: worker.username,
            password: worker.password, port: worker.ssh_port,
        });

        const encoded = Buffer.from(stopScript).toString('base64');
        const result = await ssh.exec(`echo '${encoded}' | base64 -d | bash`);

        if (result.code !== 0) {
            logger.warn(`${logPrefix}: Stop script exited ${result.code}: ${result.stderr}`);
        }

        // Clean up warm pool entry if any
        warmPool.deleteByContainer(containerId);

        containers.updateStatus(containerId, 'stopped');
        logger.info(`${logPrefix}: Stopped and removed`);
    } finally {
        if (ssh) ssh.close();
    }
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

function allocatePoolIndex(workerId) {
    const activeContainers = containers.findByWorker(workerId);
    const usedIndices = new Set();

    for (const c of activeContainers) {
        if (c.metadata) {
            try {
                const meta = JSON.parse(c.metadata);
                if (meta.poolIndex !== undefined) usedIndices.add(meta.poolIndex);
            } catch (_) { }
        }
    }

    for (let i = 0; i < 100; i++) {
        if (!usedIndices.has(i)) return i;
    }
    throw new Error('No pool index available (maximum containers reached per worker)');
}

module.exports = { launchContainer, unpauseContainer, pauseContainer, stopContainer };
