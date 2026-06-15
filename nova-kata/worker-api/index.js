/**
 * Nova Worker API — lightweight HTTP agent running on each worker VM.
 *
 * Accepts commands from the Placement Service (nova-kata) and executes
 * nerdctl commands locally. Eliminates SSH overhead for container ops.
 *
 * Auth: Shared API key via X-Worker-Key header.
 */
const express = require('express');
const { exec } = require('child_process');
const crypto = require('crypto');
const util = require('util');
const execPromise = util.promisify(exec);

const app = express();

// ── Request size limiting ──────────────────────────────────────────────────
// 10MB max — prevents OOM from oversized payloads
app.use(express.json({ limit: '10mb' }));

const API_KEY = process.env.WORKER_API_KEY || 'nova-worker-default-key';
const PORT = parseInt(process.env.WORKER_API_PORT) || 3005;
const NERDCTL_TIMEOUT = 60000; // 60s default for nerdctl commands

// ── Input validation ────────────────────────────────────────────────────────
// Container names: only allow alphanumeric, dashes, underscores, dots
const CONTAINER_NAME_REGEX = /^[a-zA-Z0-9._-]+$/;

// Path safety: must be under /opt/nova/ and no path traversal (..)
function isSafePath(p) {
    if (!p.startsWith('/opt/nova/')) return false;
    if (p.includes('..')) return false;
    return true;
}

// ── Auth Middleware ──────────────────────────────────────────────────────────
// Timing-safe comparison to prevent timing attacks on API key
app.use((req, res, next) => {
    const key = req.headers['x-worker-key'];
    if (!key) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    // Timing-safe comparison
    const a = Buffer.from(String(key));
    const b = Buffer.from(String(API_KEY));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
});

// ── Warn on default API key ────────────────────────────────────────────────
if (API_KEY === 'nova-worker-default-key') {
    console.warn('⚠️  WARNING: Using default WORKER_API_KEY. Set WORKER_API_KEY env var in production!');
}

// ── POST /unpause ───────────────────────────────────────────────────────────
app.post('/unpause', async (req, res) => {
    const { container_name } = req.body;
    if (!container_name) return res.status(400).json({ error: 'container_name required' });
    if (!CONTAINER_NAME_REGEX.test(container_name)) return res.status(400).json({ error: 'Invalid container_name' });

    try {
        const { stdout, stderr } = await execPromise(
            `nerdctl unpause ${container_name}`, { timeout: NERDCTL_TIMEOUT }
        );
        res.json({ success: true, stdout: stdout.trim(), stderr: stderr.trim() });
    } catch (err) {
        res.status(500).json({ error: err.message, stderr: err.stderr?.trim() });
    }
});

// ── POST /pause ─────────────────────────────────────────────────────────────
app.post('/pause', async (req, res) => {
    const { container_name } = req.body;
    if (!container_name) return res.status(400).json({ error: 'container_name required' });
    if (!CONTAINER_NAME_REGEX.test(container_name)) return res.status(400).json({ error: 'Invalid container_name' });

    try {
        const { stdout, stderr } = await execPromise(
            `nerdctl pause ${container_name}`, { timeout: NERDCTL_TIMEOUT }
        );
        res.json({ success: true, stdout: stdout.trim(), stderr: stderr.trim() });
    } catch (err) {
        res.status(500).json({ error: err.message, stderr: err.stderr?.trim() });
    }
});

// ── GET /health ─────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
    const result = { status: 'ok', uptime: process.uptime() };

    try {
        const { stdout } = await execPromise('ctr version 2>&1', { timeout: 5000 });
        result.containerd = stdout.trim();
        result.containerd_ok = true;
    } catch (_) {
        result.containerd_ok = false;
    }

    try {
        const { stdout } = await execPromise('uptime', { timeout: 5000 });
        result.uptime_cmd = stdout.trim();
    } catch (_) {}

    res.json(result);
});

// ── GET /ps ────────────────────────────────────────────────────────────────
// Returns all containers with name + status for reconciliation
app.get('/ps', async (req, res) => {
    try {
        const { stdout } = await execPromise(
            "nerdctl ps -a --format '{{.Names}}|{{.Status}}'",
            { timeout: 10000 }
        );
        const containers = stdout.trim().split('\n').filter(Boolean).map(line => {
            const sep = line.indexOf('|');
            return {
                name: sep > 0 ? line.slice(0, sep) : line,
                status: sep > 0 ? line.slice(sep + 1) : 'unknown',
            };
        });
        res.json({ containers });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /stats ──────────────────────────────────────────────────────────────
app.get('/stats', async (req, res) => {
    const result = { containers: { running: 0, paused: 0, total: 0 }, memory: {}, cpu: {}, disk: {} };

    // Container counts
    try {
        const { stdout } = await execPromise('nerdctl ps -a --format json 2>/dev/null || nerdctl ps -a 2>/dev/null', { timeout: 10000 });
        try {
            const containers = JSON.parse(stdout);
            result.containers.total = containers.length;
            result.containers.running = containers.filter(c => c.Status === 'Up' || c.Status === 'Running').length;
            result.containers.paused = containers.filter(c => c.Status === 'Paused').length;
        } catch (_) {
            const lines = stdout.trim().split('\n').filter(l => l.trim());
            result.containers.total = Math.max(0, lines.length - 1);
        }
    } catch (_) {}

    // Memory info
    try {
        const { stdout } = await execPromise('cat /proc/meminfo', { timeout: 5000 });
        const parseMemField = (field) => {
            const match = stdout.match(new RegExp(`${field}:\\s+(\\d+)`));
            return match ? parseInt(match[1]) * 1024 : 0; // Convert kB to bytes
        };
        const total = parseMemField('MemTotal');
        const available = parseMemField('MemAvailable');
        result.memory = {
            total_bytes: total,
            available_bytes: available,
            used_bytes: total - available,
            used_percent: total > 0 ? Math.round(((total - available) / total) * 100) : 0,
        };
    } catch (_) {}

    // CPU info
    try {
        const { stdout } = await execPromise('cat /proc/loadavg', { timeout: 5000 });
        const parts = stdout.trim().split(/\s+/);
        result.cpu = {
            load_1min: parseFloat(parts[0]) || 0,
            load_5min: parseFloat(parts[1]) || 0,
            load_15min: parseFloat(parts[2]) || 0,
        };
    } catch (_) {}

    // Disk info
    try {
        const { stdout } = await execPromise('df -B1 / 2>/dev/null | tail -1', { timeout: 5000 });
        const parts = stdout.trim().split(/\s+/);
        if (parts.length >= 4) {
            const total = parseInt(parts[1]) || 0;
            const used = parseInt(parts[2]) || 0;
            result.disk = {
                total_bytes: total,
                used_bytes: used,
                available_bytes: parseInt(parts[3]) || 0,
                used_percent: total > 0 ? Math.round((used / total) * 100) : 0,
            };
        }
    } catch (_) {}

    try {
        const { stdout } = await execPromise('nerdctl version 2>&1', { timeout: 5000 });
        result.nerdctl_version = stdout.trim();
    } catch (_) {}

    result.timestamp = Date.now();
    res.json(result);
});

// ── GET /container-stats ────────────────────────────────────────────────────
// Returns per-container CPU and memory usage via nerdctl stats
app.get('/container-stats', async (req, res) => {
    try {
        const { stdout } = await execPromise(
            'nerdctl stats --no-stream --format json 2>/dev/null',
            { timeout: 15000 }
        );
        try {
            // nerdctl >= 1.7 returns JSON array
            const stats = JSON.parse(stdout);
            const containers = stats.map(s => ({
                name: s.Name || '',
                cpu_percent: parseFloat(s.CPUPerc) || 0,
                memory_used_bytes: parseMemBytes(s.MemUsage),
                memory_limit_bytes: parseMemLimit(s.MemUsage),
                memory_percent: parseFloat(s.MemPerc) || 0,
                pids: parseInt(s.PIDs) || 0,
                net_io: s.NetIO || '',
                block_io: s.BlockIO || '',
            }));
            res.json({ containers });
        } catch (_) {
            // Fallback: parse text table format
            const lines = stdout.trim().split('\n').filter(l => l.trim());
            const containers = [];
            // Skip header line
            for (let i = 1; i < lines.length; i++) {
                const parts = lines[i].split(/\s+/);
                if (parts.length >= 4) {
                    containers.push({
                        name: parts[1] || '',
                        cpu_percent: parseFloat(parts[2]) || 0,
                        memory_percent: parseFloat(parts[4]) || 0,
                    });
                }
            }
            res.json({ containers });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Parse memory usage string like "128MB / 512MB" → bytes
function parseMemBytes(str) {
    if (!str || !str.includes('/')) return 0;
    const used = str.split('/')[0].trim();
    return parseMemValue(used);
}
function parseMemLimit(str) {
    if (!str || !str.includes('/')) return 0;
    const limit = str.split('/')[1].trim();
    return parseMemValue(limit);
}
function parseMemValue(val) {
    if (!val) return 0;
    const match = val.match(/^([\d.]+)\s*(KiB|MiB|GiB|KB|MB|GB)/i);
    if (!match) return 0;
    const num = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    if (unit.startsWith('K')) return num * 1024;
    if (unit.startsWith('M')) return num * 1024 * 1024;
    if (unit.startsWith('G')) return num * 1024 * 1024 * 1024;
    return num;
}

// ── GET /ksm-stats ──────────────────────────────────────────────────────────
// Returns KSM deduplication statistics
app.get('/ksm-stats', async (req, res) => {
    const stats = {};
    try {
        const { stdout } = await execPromise('cat /sys/kernel/mm/ksm/run', { timeout: 5000 });
        stats.enabled = stdout.trim() === '1';
    } catch (_) { stats.enabled = false; }
    try {
        const { stdout } = await execPromise('cat /sys/kernel/mm/ksm/pages_sharing', { timeout: 5000 });
        stats.pages_sharing = parseInt(stdout.trim()) || 0;
        stats.mb_saved = Math.round(stats.pages_sharing * 4096 / 1024 / 1024);
    } catch (_) { stats.pages_sharing = 0; stats.mb_saved = 0; }
    try {
        const { stdout } = await execPromise('cat /sys/kernel/mm/ksm/pages_shared', { timeout: 5000 });
        stats.pages_shared = parseInt(stdout.trim()) || 0;
    } catch (_) { stats.pages_shared = 0; }
    try {
        const { stdout } = await execPromise('cat /sys/kernel/mm/ksm/pages_to_scan', { timeout: 5000 });
        stats.pages_to_scan = parseInt(stdout.trim()) || 0;
    } catch (_) {}
    res.json(stats);
});

// ── POST /stop ──────────────────────────────────────────────────────────────
// Stop and remove a container. Handles unpause if needed.
// Eliminates SSH overhead for container cleanup.
app.post('/stop', async (req, res) => {
    const { container_name } = req.body;
    if (!container_name) return res.status(400).json({ error: 'container_name required' });
    if (!CONTAINER_NAME_REGEX.test(container_name)) return res.status(400).json({ error: 'Invalid container_name' });

    try {
        const { stdout, stderr } = await execPromise(
            `nerdctl unpause ${container_name} 2>/dev/null; nerdctl stop ${container_name} 2>/dev/null; nerdctl rm -f ${container_name} 2>/dev/null; echo '{"status":"stopped"}'`,
            { timeout: NERDCTL_TIMEOUT }
        );
        res.json({ success: true, stdout: stdout.trim(), stderr: stderr.trim() });
    } catch (err) {
        // Even if some steps fail, the container may still be cleaned up
        res.json({ success: true, stdout: '', stderr: err.stderr?.trim() || err.message });
    }
});

// ── POST /write-file ────────────────────────────────────────────────────────
// Write a base64-encoded file to disk. Used by build flow to upload source files.
app.post('/write-file', async (req, res) => {
    const { path: filePath, content_base64, mode } = req.body;
    if (!filePath || !content_base64) return res.status(400).json({ error: 'path and content_base64 required' });

    // Validate path — must be under /opt/nova/ and no path traversal
    if (!isSafePath(filePath)) {
        return res.status(403).json({ error: 'Path must be under /opt/nova/ and must not contain ..' });
    }

    try {
        const mkdirCmd = `mkdir -p "$(dirname '${filePath}')"`;
        await execPromise(mkdirCmd, { timeout: 5000 });
        const writeCmd = `echo '${content_base64}' | base64 -d > '${filePath}'`;
        await execPromise(writeCmd, { timeout: 30000 });
        if (mode) {
            await execPromise(`chmod ${mode} '${filePath}'`, { timeout: 5000 });
        }
        res.json({ success: true, path: filePath });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── POST /build ─────────────────────────────────────────────────────────────
// Run nerdctl build + push on the worker. Used by buildService.js.
app.post('/build', async (req, res) => {
    const { build_dir, tag, no_cache } = req.body;
    if (!build_dir || !tag) return res.status(400).json({ error: 'build_dir and tag required' });

    // Validate paths — must be under /opt/nova/ and no path traversal
    if (!isSafePath(build_dir)) {
        return res.status(403).json({ error: 'build_dir must be under /opt/nova/ and must not contain ..' });
    }

    try {
        const noCacheFlag = no_cache ? '--no-cache' : '';
        const { stdout, stderr } = await execPromise(
            `cd ${build_dir} && nerdctl build ${noCacheFlag} -t ${tag} . && nerdctl push --insecure-registry ${tag}`,
            { timeout: 300000 } // 5 min — builds can be slow
        );
        res.json({ success: true, stdout: stdout.trim(), stderr: stderr.trim() });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
            stdout: err.stdout?.trim() || '',
            stderr: err.stderr?.trim() || '',
        });
    }
});

// ── POST /exec ──────────────────────────────────────────────────────────────
// Execute a single command on the worker. Used by buildService.js for misc commands.
app.post('/exec', async (req, res) => {
    const { command, timeout } = req.body;
    if (!command) return res.status(400).json({ error: 'command required' });

    try {
        const { stdout, stderr } = await execPromise(command, {
            timeout: timeout || 30000,
        });
        res.json({ success: true, stdout: stdout.trim(), stderr: stderr.trim(), exit_code: 0 });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
            stdout: err.stdout?.trim() || '',
            stderr: err.stderr?.trim() || '',
            exit_code: err.code || 1,
        });
    }
});

// ── POST /launch ────────────────────────────────────────────────────────────
// Execute a base64-encoded launch script on the worker.
// Used by the Placement Service to launch containers without SSH.
// Eliminates ~1s SSH handshake overhead on cold starts.
app.post('/launch', async (req, res) => {
    const { script_base64 } = req.body;
    if (!script_base64) return res.status(400).json({ error: 'script_base64 required' });

    try {
        const { stdout, stderr } = await execPromise(
            `echo '${script_base64}' | base64 -d | bash`,
            { timeout: 90000 } // 90s — Kata VM boot can take 5-15s
        );
        res.json({ success: true, stdout: stdout.trim(), stderr: stderr.trim() });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
            stdout: err.stdout?.trim() || '',
            stderr: err.stderr?.trim() || '',
            exit_code: err.code || 1,
        });
    }
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Nova Worker API listening on 0.0.0.0:${PORT}`);
});