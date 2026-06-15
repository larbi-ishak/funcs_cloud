const { createSSHClient } = require('../utils/ssh');
const logger = require('../utils/logger');

/**
 * Provisions a fresh worker VM over SSH.
 *
 * Runs all setup steps (containerd, Kata, CNI, nerdctl, BuildKit, registry)
 * directly via SSH — no Ansible or WSL required.
 *
 * @param {object}   params
 * @param {string}   params.ip
 * @param {string}   params.username
 * @param {string}   params.password
 * @param {number}   [params.ssh_port=22]
 * @param {Function} [params.onLine]   Optional callback(line) for live log streaming.
 * @returns {Promise<void>}
 */
async function provisionWorker({ ip, username, password, ssh_port = 22, onLine }) {
    logger.info(`Starting provisioning for worker ${ip}...`);

    const log = (line) => {
        logger.info(`[provision] ${line}`);
        if (typeof onLine === 'function') onLine(line);
    };

    let ssh;
    try {
        ssh = await createSSHClient({ ip, username, password, port: ssh_port });
    } catch (err) {
        throw new ProvisionError(`SSH connection failed: ${err.message}`, 'SSH_CONNECT_FAILED');
    }

    try {
        // Check if we're already root — if so, no need for sudo
        const whoami = await ssh.exec('whoami');
        const isRoot = whoami.stdout.trim() === 'root';
        log(`Connected as ${whoami.stdout.trim()} (root: ${isRoot})`);

        /**
         * Run a shell command on the remote host.
         * When not root, wraps the command in:
         *   echo "pass" | sudo -S bash -c 'cmd'
         * This handles &&-chains, pipes, redirections, and heredocs correctly.
         * @param {string} label   Human-readable step name
         * @param {string} cmd     Shell command to run
         * @param {number} [timeout=30000]  Per-command timeout in ms
         */
        const run = async (label, cmd, timeout = 30_000) => {
            log(`▶ ${label}`);
            const fullCmd = isRoot
                ? `bash -c ${JSON.stringify(cmd)}`
                : `echo ${JSON.stringify(password)} | sudo -S bash -c ${JSON.stringify(cmd)}`;
            const result = await ssh.exec(fullCmd, timeout);
            if (result.stdout) result.stdout.split('\n').filter(Boolean).forEach(log);
            // Filter out the sudo password prompt line from stderr display
            const errLines = result.stderr.split('\n').filter(l => l && !l.startsWith('[sudo]'));
            if (errLines.length) errLines.forEach(l => log(`  ${l}`));
            if (result.code !== 0) {
                throw new ProvisionError(
                    `Step "${label}" failed (exit ${result.code}): ${result.stderr || result.stdout}`,
                    'STEP_FAILED'
                );
            }
            log(`✔ ${label}`);
        };

        // ── Step 0: Clean up broken repos from previous attempts ────────────────
        await run('Clean up broken apt repos', 'rm -f /etc/apt/sources.list.d/nodesource.list /etc/apt/keyrings/nodesource.gpg /etc/apt/sources.list.d/nodesource.repo', 10_000);

        // ── Step 1: Dependencies ──────────────────────────────────────────────
        await run('Install dependencies', 'apt-get update -qq && apt-get install -y curl wget tar', 3 * 60_000);

        // ── Step 1: Containerd ────────────────────────────────────────────────
        const CTR_VERSION = '1.7.20';
        await run('Download containerd', [
            `wget -q https://github.com/containerd/containerd/releases/download/v${CTR_VERSION}/containerd-${CTR_VERSION}-linux-amd64.tar.gz`,
            `-O /tmp/containerd-${CTR_VERSION}.tar.gz`,
        ].join(' '), 5 * 60_000);
        await run('Extract containerd', `tar Cxzf /usr/local /tmp/containerd-${CTR_VERSION}.tar.gz`);
        await run('Install containerd systemd service', [
            'wget -q https://raw.githubusercontent.com/containerd/containerd/main/containerd.service',
            '-O /etc/systemd/system/containerd.service',
        ].join(' '), 2 * 60_000);
        await run('Enable containerd', 'systemctl daemon-reload && systemctl enable --now containerd');
        await run('Verify containerd', 'ctr version');

        // ── Step 2: Kata Containers ───────────────────────────────────────────
        // Skip entirely if already installed from a previous run
        const kataExists = await ssh.exec('test -d /opt/kata/bin && echo yes || echo no');
        if (kataExists.stdout.trim() === 'yes') {
            log('✔ Kata Containers already installed — skipping');
        } else {
            // Also check /tmp/opt/kata — might be from a previous failed run (skip re-download)
            const kataTmpExists = await ssh.exec('test -d /tmp/opt/kata/bin && echo yes || echo no');
            if (kataTmpExists.stdout.trim() !== 'yes') {
                await run('Download kata-manager', [
                    'curl -fsSL https://raw.githubusercontent.com/kata-containers/kata-containers/main/utils/kata-manager.sh',
                    '-o /tmp/kata-manager.sh && chmod +x /tmp/kata-manager.sh',
                ].join(' '), 2 * 60_000);
                // kata-manager exits 1 because it checks /opt/kata/bin before we move it — use || true
                await run(
                    'Install Kata Containers',
                    'cd /tmp && bash /tmp/kata-manager.sh -o || true',
                    15 * 60_000
                );
            } else {
                log('✔ Kata bundle already in /tmp/opt/kata — skipping re-download');
            }
            // Verify the extracted directory is actually there before moving
            await run('Verify Kata extract', 'test -d /tmp/opt/kata/bin || (echo "kata-manager extraction failed" && exit 1)');
            await run('Move Kata to /opt/kata', 'mv /tmp/opt/kata /opt/kata');
        }

        // ── Step 3: Environment ───────────────────────────────────────────────
        await run('Add Kata to PATH', "echo 'export PATH=$PATH:/opt/kata/bin' > /etc/profile.d/kata.sh");
        await run('Create shim symlink', [
            'ln -sf /opt/kata/bin/containerd-shim-kata-v2',
            '/usr/local/bin/containerd-shim-kata-v2',
        ].join(' '));

        // ── Step 4: CNI Plugins ───────────────────────────────────────────────
        const CNI_VERSION = '1.4.0';
        await run('Create CNI dir', 'mkdir -p /opt/cni/bin');
        await run('Download CNI plugins', [
            `wget -q https://github.com/containernetworking/plugins/releases/download/v${CNI_VERSION}/cni-plugins-linux-amd64-v${CNI_VERSION}.tgz`,
            `-O /tmp/cni-plugins.tgz`,
        ].join(' '), 5 * 60_000);
        await run('Extract CNI plugins', 'tar -xzf /tmp/cni-plugins.tgz -C /opt/cni/bin');

        // ── Step 5: Nerdctl ───────────────────────────────────────────────────
        const NERDCTL_VERSION = '1.7.6';
        await run('Download nerdctl', [
            `wget -q https://github.com/containerd/nerdctl/releases/download/v${NERDCTL_VERSION}/nerdctl-${NERDCTL_VERSION}-linux-amd64.tar.gz`,
            `-O /tmp/nerdctl.tar.gz`,
        ].join(' '), 5 * 60_000);
        await run('Extract nerdctl', 'tar -xzf /tmp/nerdctl.tar.gz -C /tmp');
        await run('Install nerdctl', 'mv /tmp/nerdctl /usr/local/bin/ && chmod +x /usr/local/bin/nerdctl');
        await run('Verify nerdctl', 'nerdctl version');

        // ── Step 6: Kata Runtime Config ───────────────────────────────────────
        await run('Link Kata configuration.toml', [
            'ln -sf /opt/kata/share/defaults/kata-containers/configuration-qemu.toml',
            '/opt/kata/share/defaults/kata-containers/configuration.toml',
        ].join(' '));

        // ── Step 6b: Enable Memory Ballooning ──────────────────────────────────
        // reclaim_guest_freed_memory = true attaches virtio-balloon PCI device
        // and enables free-page-reporting so the host can reclaim unused guest RAM.
        // Critical for warm pool density — paused containers return free pages to host.
        await run('Enable Kata memory ballooning', [
            'sed -i',
            '"s/^reclaim_guest_freed_memory = false/reclaim_guest_freed_memory = true/"',
            '/opt/kata/share/defaults/kata-containers/configuration-qemu.toml',
            '|| true',
        ].join(' '));

        // ── Step 6b2: Virtio-FS thread pool ────────────────────────────────────
        // Default is --thread-pool-size=1 which serializes all file reads across
        // the guest/host boundary. During cold starts, Node.js/Python read thousands
        // of tiny files (node_modules, site-packages). Single-threaded virtiofsd
        // is a major I/O bottleneck. Bumping to 4 threads parallelizes reads.
        await run('Increase virtiofsd thread pool', [
            'sed -i',
            '"s/--thread-pool-size=1/--thread-pool-size=4/"',
            '/opt/kata/share/defaults/kata-containers/configuration-qemu.toml',
            '|| true',
        ].join(' '));

        // ── Step 6c: Enable KSM (Kernel Samepage Merging) ──────────────────────
        // KSM deduplicates identical memory pages across Kata VMs.
        // With 20 Python warm containers, saves ~500-600MB by deduping guest kernels,
        // Python interpreter, and nova_agent code.
        // ksmtuned auto-adjusts scan rate based on host RAM pressure.
        await run('Enable KSM', [
            'echo 1 > /sys/kernel/mm/ksm/run &&',
            'echo 1000 > /sys/kernel/mm/ksm/pages_to_scan &&',
            'echo 200 > /sys/kernel/mm/ksm/sleep_millisecs',
        ].join(' '));
        await run('Install ksmtuned (adaptive KSM)', [
            'apt-get install -y ksm-tools 2>/dev/null || true &&',
            'systemctl enable ksmtuned 2>/dev/null || true &&',
            'systemctl start ksmtuned 2>/dev/null || true',
        ].join(' '));

        // ── Step 7: Configure Containerd ─────────────────────────────────────
        await run('Generate containerd config', [
            'mkdir -p /etc/containerd &&',
            'containerd config default > /etc/containerd/config.toml',
        ].join(' '));
        await run('Enable SystemdCgroup', [
            "sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml",
        ].join(' '));
        // Encode as base64 in Node.js — avoids heredoc/quoting issues over SSH
        const kataRuntimeBlock = Buffer.from(
            `
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata]
  runtime_type = "io.containerd.kata.v2"
  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata.options]
    ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration.toml"
`).toString('base64');
        await run(
            'Add Kata runtime to containerd config',
            `echo '${kataRuntimeBlock}' | base64 -d >> /etc/containerd/config.toml`
        );
        await run('Restart containerd', 'systemctl restart containerd');

        // ── Steps 8-9: BuildKit ───────────────────────────────────────────────
        const BUILDKIT_VERSION = '0.13.2';
        await run('Install runc', 'apt-get install -y runc', 3 * 60_000);
        await run('Download BuildKit', [
            `wget -q https://github.com/moby/buildkit/releases/download/v${BUILDKIT_VERSION}/buildkit-v${BUILDKIT_VERSION}.linux-amd64.tar.gz`,
            `-O /tmp/buildkit.tar.gz`,
        ].join(' '), 5 * 60_000);
        await run('Extract BuildKit', 'tar -xzf /tmp/buildkit.tar.gz -C /usr/local');
        const buildkitService = Buffer.from(
            `[Unit]
Description=BuildKit
Documentation=https://github.com/moby/buildkit

[Service]
ExecStart=/usr/local/bin/buildkitd
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`).toString('base64');
        await run(
            'Create BuildKit service',
            `echo '${buildkitService}' | base64 -d > /etc/systemd/system/buildkit.service`
        );
        await run('Enable BuildKit', 'systemctl daemon-reload && systemctl enable --now buildkit');

        // ── Step 10: Shared Registry Config ────────────────────────────────────
        // Workers pull/push from the shared registry (REGISTRY_HOST, e.g., 10.128.0.21:5000).
        // Configure containerd to trust the insecure (HTTP) registry.
        const registryHost = process.env.REGISTRY_HOST || 'localhost:5000';
        if (registryHost !== 'localhost:5000') {
            log(`Configuring shared registry: ${registryHost}`);
            const hostsToml = Buffer.from(
                `server = "http://${registryHost}"\n\n[host."http://${registryHost}"]\n  skip_verify = true\n`
            ).toString('base64');
            await run(
                'Add insecure registry to containerd',
                `mkdir -p /etc/containerd/certs.d/${registryHost} && echo '${hostsToml}' | base64 -d > /etc/containerd/certs.d/${registryHost}/hosts.toml`
            );
            await run('Restart containerd for registry', 'systemctl restart containerd');
        } else {
            // Dev mode: start a local registry on the worker
            await run('Start local registry', [
                'nerdctl inspect nova-registry > /dev/null 2>&1 ||',
                'nerdctl run -d --name nova-registry -p 5000:5000 --restart always registry:2',
            ].join(' '));
        }

        // ── Step 11: (Removed — Nginx no longer needed) ────────────────────────
        // Containers now use nerdctl -p port mapping (iptables/NAT).
        // The gateway routes directly to worker_ip:hostPort.
        // No nginx install, no config write, no reload thrashing.

        // ── Step 12: Network Isolation ────────────────────────────────────────
        // Isolate containers from each other and block access to cloud metadata
        //       await run('Install iptables-persistent', 'apt-get install -y iptables-persistent', 2 * 60_000);
        //      await run('Apply iptables isolation rules', [
        // Ensure nerdctl network exists first so the interface is created (nerdctl network create will fail if already exists)
        //         'nerdctl network create bridge || true',
        // Drop inter-container communication
        //        'iptables -C FORWARD -i nerdctl0 -o nerdctl0 -j DROP || iptables -I FORWARD -i nerdctl0 -o nerdctl0 -j DROP',
        // Drop access to AWS/GCP metadata server
        //       'iptables -C FORWARD -i nerdctl0 -d 169.254.169.254 -j DROP || iptables -I FORWARD -i nerdctl0 -d 169.254.169.254 -j DROP',
        // Save iptables rules to persist across reboots
        //      'iptables-save > /etc/iptables/rules.v4'
        // ].join(' && '));

        // ── Step 13: Worker API ───────────────────────────────────────────────────
        // Lightweight HTTP agent for container ops (pause/unpause/health/stats).
        // Eliminates SSH overhead on the hot path.
        const workerApiKey = process.env.WORKER_API_KEY || 'nova-worker-default-key';
        const workerApiPort = process.env.WORKER_API_PORT || '3005';

        // Install Node.js (required by Worker API)
        // Use direct binary download — avoids apt repo/GPG issues with NodeSource.
        const nodeExists = await ssh.exec('test -x /usr/local/bin/node && echo yes || echo no');
        if (nodeExists.stdout.trim() !== 'yes') {
            // Clean up any broken NodeSource repo from previous attempts
            await run('Clean up NodeSource repo', 'rm -f /etc/apt/sources.list.d/nodesource.list /etc/apt/keyrings/nodesource.gpg /etc/apt/sources.list.d/nodesource.repo', 10_000);
            // Download Node.js 20 LTS binary directly (no apt, no GPG issues)
            const NODE_VERSION = '20.11.1';
            await run('Download Node.js binary', [
                `wget -q https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz`,
                `-O /tmp/node.tar.xz`,
            ].join(' '), 60_000);
            await run('Extract Node.js to /usr/local', 'tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1');
            await run('Verify Node.js', '/usr/local/bin/node --version');
        } else {
            log('✔ Node.js already installed — skipping');
        }

        await run('Create Worker API directory', 'mkdir -p /opt/nova/worker-api');

        // Upload Worker API files via base64 (SSH-safe)
        const workerApiIndex = require('fs').readFileSync(require('path').join(__dirname, '../../worker-api/index.js'), 'utf8');
        const workerApiPkg = require('fs').readFileSync(require('path').join(__dirname, '../../worker-api/package.json'), 'utf8');
        const workerApiService = require('fs').readFileSync(require('path').join(__dirname, '../../worker-api/nova-worker-api.service'), 'utf8');

        await run('Upload Worker API index.js', `echo '${Buffer.from(workerApiIndex).toString('base64')}' | base64 -d > /opt/nova/worker-api/index.js`);
        await run('Upload Worker API package.json', `echo '${Buffer.from(workerApiPkg).toString('base64')}' | base64 -d > /opt/nova/worker-api/package.json`);

        // Write .env for Worker API (use echo to avoid heredoc issues over SSH)
        await run('Write Worker API .env', [
            `echo 'WORKER_API_KEY=${workerApiKey}' > /opt/nova/worker-api/.env`,
            `&& echo 'WORKER_API_PORT=${workerApiPort}' >> /opt/nova/worker-api/.env`,
        ].join(' '));

        await run('Install Worker API dependencies', 'cd /opt/nova/worker-api && /usr/local/bin/npm install --production', 120_000);

        // Install systemd service
        await run('Upload systemd service', `echo '${Buffer.from(workerApiService).toString('base64')}' | base64 -d > /etc/systemd/system/nova-worker-api.service`);
        await run('Enable and start Worker API', 'systemctl daemon-reload && systemctl enable --now nova-worker-api');

        // Open firewall port for Worker API (internal only)
        await run('Open Worker API port', `iptables -C INPUT -p tcp --dport ${workerApiPort} -j ACCEPT || iptables -I INPUT -p tcp --dport ${workerApiPort} -j ACCEPT`);

        log('🎉 Provisioning complete!');


    } catch (err) {
        if (err instanceof ProvisionError) throw err;
        throw new ProvisionError(err.message, 'UNKNOWN');
    } finally {
        ssh.close();
    }
}

class ProvisionError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'ProvisionError';
        this.code = code;
    }
}

module.exports = { provisionWorker, ProvisionError };
