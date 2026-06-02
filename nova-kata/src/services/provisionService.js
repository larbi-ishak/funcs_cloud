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

        // ── Step 10: Private Registry ─────────────────────────────────────────
        await run('Start local registry', [
            'nerdctl inspect nova-registry > /dev/null 2>&1 ||',
            'nerdctl run -d --name nova-registry -p 5000:5000 --restart always registry:2',
        ].join(' '));

        // ── Step 11: Nginx (reverse proxy for container routing) ──────────────
        // containerService.js writes /etc/nginx/conf.d/nova-*.conf for each
        // container and calls `nginx -s reload` — nginx must be installed.
        await run('Install nginx', 'apt-get install -y nginx', 3 * 60_000);
        await run('Ensure nginx conf.d exists', 'mkdir -p /etc/nginx/conf.d');
        await run('Enable nginx', 'systemctl enable --now nginx');

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
