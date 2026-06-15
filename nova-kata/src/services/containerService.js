const { v4: uuidv4 } = require('uuid');
const { createSSHClient } = require('../utils/ssh');
const { workers, containers, warmPool } = require('../db/database');
const logger = require('../utils/logger');
const { logTiming } = require('../utils/timingLogger');
const axios = require('axios');
const http = require('http');

const REGISTRY_HOST = process.env.REGISTRY_HOST || 'localhost:5000';
const WORKER_API_KEY = process.env.WORKER_API_KEY || 'nova-worker-default-key';
const WORKER_API_PORT = parseInt(process.env.WORKER_API_PORT) || 3005;

// ── Persistent HTTP client for Worker API (keep-alive, no handshake per request) ──
const workerApiClient = axios.create({
    httpAgent: new http.Agent({
        keepAlive: true,
        keepAliveMsecs: 30000,
        maxSockets: 50,
    }),
    timeout: 30000,
    headers: { 'X-Worker-Key': WORKER_API_KEY },
});
const DEFAULT_IMAGE = process.env.DEFAULT_IMAGE || `${REGISTRY_HOST}/nova-fn-hello:latest`;
const DEFAULT_RUNTIME = process.env.DEFAULT_RUNTIME || 'io.containerd.kata.v2';

// ── Image name validation (prevents shell injection) ──────────────────────────
// Allowed format: [registry/]name[:tag] — rejects shell metacharacters
const IMAGE_REGEX = /^(?:[a-zA-Z0-9._-]+(?::\d+)?\/)?[a-zA-Z0-9._-]+(?::[a-zA-Z0-9._-]+)?$/;

function validateImageName(image) {
    if (!image || typeof image !== 'string') {
        throw new Error('Image name is required and must be a string');
    }
    if (!IMAGE_REGEX.test(image)) {
        throw new Error(
            `Invalid image name: "${image}". ` +
            `Allowed format: [registry/]name[:tag]. ` +
            `No shell metacharacters allowed.`
        );
    }
}
const DEFAULT_SNAPSHOTTER = process.env.DEFAULT_SNAPSHOTTER || 'overlayfs';
const DEFAULT_AGENT_CMD = process.env.DEFAULT_AGENT_CMD || 'python3 /nova_agent.py';
const DEFAULT_AGENT_PORT = parseInt(process.env.DEFAULT_AGENT_PORT) || 8080;

/**
 * Launch a new container via nerdctl on a worker.
 *
 * Uses the Kata QEMU runtime with -p port mapping (nerdctl handles
 * iptables/NAT). No nginx required — the gateway routes directly to
 * worker_ip:hostPort, which nerdctl maps to the container's agent port.
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

    const image = resolveImageTag(options.image || DEFAULT_IMAGE);
    validateImageName(image);
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
        started_at: new Date().toISOString(),
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

# ── 1. Run container with Kata QEMU runtime + port mapping ────────────────────
# -p ${hostPort}:${agentPort} maps worker host port → container agent port
# No nginx needed — nerdctl handles iptables/NAT forwarding directly.
# --pull missing: use local cache if available, otherwise pull from registry
nerdctl run \\
  --pull missing \\
  --insecure-registry \\
  --runtime ${runtime} \\
  --snapshotter ${DEFAULT_SNAPSHOTTER} \\
  -p ${hostPort}:${agentPort} \\
  ${memoryLimit} \\
  ${cpuLimit} \\
  ${envFlags.join(' \\\n  ')} \\
  -d \\
  --name ${containerName} \\
  ${image}

# ── 2. Wait for container to be ready (Kata VMs need time to boot) ───────────
# Poll every 0.2s instead of 1s — reduces IP detection from ~3s to ~0.6s
CONTAINER_IP=""
ELAPSED=0
while [ $ELAPSED -lt 15000 ]; do
    sleep 0.2
    ELAPSED=$((ELAPSED + 200))
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

# ── 3. Optionally pause for warm pool ────────────────────────────────────────
${pauseAfter ? `sleep 2\nnerdctl pause ${containerName}` : '# not pausing'}

printf '{"container_ip":"%s","host_port":${hostPort},"status":"ok"}\\n' "$CONTAINER_IP"
`;

    const encoded = Buffer.from(launchScript).toString('base64');
    let launchVia = 'unknown';

    try {
        // ── Try Worker API first (no SSH handshake, saves ~1s) ────────────────
        const t_api = performance.now();
        try {
            const response = await workerApiClient.post(
                `http://${worker.ip}:${WORKER_API_PORT}/launch`,
                { script_base64: encoded },
                { timeout: 90000 }
            );

            if (response.data && response.data.success) {
                launchVia = 'worker_api';
                logTiming(rid, 'worker_api_launch', performance.now() - t_launch, {
                    worker_ip: worker.ip, step_ms: +(performance.now() - t_api).toFixed(2),
                });

                // Parse output for container IP
                let containerIp = null;
                try {
                    const lastLine = response.data.stdout.trim().split('\n').pop();
                    const parsed = JSON.parse(lastLine);
                    containerIp = parsed.container_ip || null;
                } catch (_) {
                    logger.warn(`${logPrefix}: Could not parse Worker API output: ${response.data.stdout}`);
                }

                const status = pauseAfter ? 'paused' : 'running';
                containers.updateStatus(containerId, status, {
                    container_ip: containerIp,
                    host_port: hostPort,
                });

                const totalMs = +(performance.now() - t_launch).toFixed(2);
                logTiming(rid, 'launch_complete', totalMs, { containerId, containerIp, total_ms: totalMs, via: 'worker_api' });
                logger.info(`${logPrefix}: Container started via Worker API (IP ${containerIp}) — ${totalMs}ms`);

                return containers.findById(containerId);
            }
            throw new Error('Worker API launch returned non-success');
        } catch (apiErr) {
            logger.warn(`${logPrefix}: Worker API launch failed (${apiErr.message}), falling back to SSH`);
        }

        // ── Fallback: SSH ────────────────────────────────────────────────────
        launchVia = 'ssh';
        const t_ssh = performance.now();
        const ssh = await createSSHClient({
            ip: worker.ip, username: worker.username,
            password: worker.password, port: worker.ssh_port,
        });
        logTiming(rid, 'ssh_connect', performance.now() - t_launch, {
            worker_ip: worker.ip, step_ms: +(performance.now() - t_ssh).toFixed(2),
        });

        try {
            const t_script = performance.now();
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
            logTiming(rid, 'launch_complete', totalMs, { containerId, containerIp, total_ms: totalMs, via: 'ssh' });
            logger.info(`${logPrefix}: Container started via SSH (IP ${containerIp}) — ${totalMs}ms`);

            return containers.findById(containerId);
        } finally {
            ssh.close();
        }
    } catch (err) {
        const totalMs = +(performance.now() - t_launch).toFixed(2);
        logTiming(rid, 'launch_failed', totalMs, { error: err.message, total_ms: totalMs, via: launchVia });
        containers.updateStatus(containerId, 'failed');
        logger.error(`${logPrefix}: Launch failed — ${err.message}`);
        throw err;
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

    // ── Try Worker API first (fast, no SSH) ─────────────────────────────────
    try {
        const response = await workerApiClient.post(
            `http://${worker.ip}:${WORKER_API_PORT}/unpause`,
            { container_name: container.container_name }
        );

        if (response.data && response.data.success) {
            containers.updateStatus(containerId, 'running');
            const totalMs = +(performance.now() - t0).toFixed(2);
            logTiming(rid, 'unpause_complete', totalMs, { total_ms: totalMs, via: 'worker_api' });
            logger.info(`${logPrefix}: Unpaused via Worker API — ${totalMs}ms`);
            return containers.findById(containerId);
        }
        throw new Error('Worker API returned non-success');
    } catch (apiErr) {
        logger.warn(`${logPrefix}: Worker API unpause failed (${apiErr.message}), falling back to SSH`);
    }

    // ── Fallback: SSH ───────────────────────────────────────────────────────
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
        logTiming(rid, 'unpause_complete', totalMs, { total_ms: totalMs, via: 'ssh' });
        logger.info(`${logPrefix}: Unpaused via SSH — ${totalMs}ms`);

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

    // ── Try Worker API first (fast, no SSH) ─────────────────────────────────
    try {
        const response = await workerApiClient.post(
            `http://${worker.ip}:${WORKER_API_PORT}/pause`,
            { container_name: container.container_name }
        );

        if (response.data && response.data.success) {
            containers.updateStatus(containerId, 'paused');
            logger.info(`${logPrefix}: Paused via Worker API`);
            return;
        }
        throw new Error('Worker API returned non-success');
    } catch (apiErr) {
        logger.warn(`${logPrefix}: Worker API pause failed (${apiErr.message}), falling back to SSH`);
    }

    // ── Fallback: SSH ───────────────────────────────────────────────────────
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
        logger.info(`${logPrefix}: Paused via SSH`);

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

# ── 2. Stop and remove container (port mapping is auto-cleaned by nerdctl) ────
nerdctl stop ${container.container_name} 2>/dev/null || true
nerdctl rm -f ${container.container_name} 2>/dev/null || true

echo '{"status":"stopped"}'
`;

    // ── Try Worker API first (no SSH handshake) ─────────────────────────────
    try {
        const response = await workerApiClient.post(
            `http://${worker.ip}:${WORKER_API_PORT}/stop`,
            { container_name: container.container_name }
        );

        if (response.data && response.data.success) {
            warmPool.deleteByContainer(containerId);
            containers.updateStatus(containerId, 'stopped');
            logger.info(`${logPrefix}: Stopped and removed via Worker API`);
            return;
        }
        throw new Error('Worker API stop returned non-success');
    } catch (apiErr) {
        logger.warn(`${logPrefix}: Worker API stop failed (${apiErr.message}), falling back to SSH`);
    }

    // ── Fallback: SSH ───────────────────────────────────────────────────────
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
        logger.info(`${logPrefix}: Stopped and removed via SSH`);
    } finally {
        if (ssh) ssh.close();
    }
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve an image tag, auto-prepending the local registry prefix
 * for legacy tags that don't include a registry (e.g. "nova-fn-node-js:latest").
 * Images with a '/' are assumed to already include a registry/host.
 */
function resolveImageTag(image) {
    if (!image) return DEFAULT_IMAGE;
    if (image.includes('/')) return image;  // already has registry prefix
    const resolved = `${REGISTRY_HOST}/${image}`;
    logger.debug(`Image tag resolved: ${image} → ${resolved}`);
    return resolved;
}

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
