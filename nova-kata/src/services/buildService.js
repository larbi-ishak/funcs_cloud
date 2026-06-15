const { createSSHClient } = require('../utils/ssh');
const logger = require('../utils/logger');
const axios = require('axios');
const http = require('http');

// ── Worker API client ──────────────────────────────────────────────────────
const WORKER_API_KEY = process.env.WORKER_API_KEY || 'nova-worker-default-key';
const WORKER_API_PORT = parseInt(process.env.WORKER_API_PORT) || 3005;
const workerApiClient = axios.create({
    httpAgent: new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 10 }),
    timeout: 30000,
    headers: { 'X-Worker-Key': WORKER_API_KEY },
});

// ── Shared Registry ────────────────────────────────────────────────────────
// REGISTRY_HOST points to the shared Docker registry (e.g., '10.128.0.21:5000').
// Defaults to localhost:5000 for dev/single-worker setups.
const REGISTRY_HOST = process.env.REGISTRY_HOST || 'localhost:5000';

// ─── Nova Agent — Python ──────────────────────────────────────────────────────
/**
 * Wraps the user's handler(event) with a full HTTP server.
 * Supports ALL methods: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS.
 *
 * event shape passed to handler():
 *   { method, path, query, headers, body (str|null), json (parsed|null) }
 *
 * handler() return shapes:
 *   - plain dict/value  → 200 JSON response
 *   - { statusCode, body, headers? } → forwarded as-is
 */
const NOVA_AGENT_PY = `
import importlib.util, json, traceback, os, sys, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

entry = os.environ.get('NOVA_ENTRY', '/function/handler.py')

# Add the function directory to sys.path so relative imports work.
# e.g. 'from services.utils import foo' finds services/ next to the entry file.
func_dir = os.path.dirname(os.path.abspath(entry))
if func_dir not in sys.path:
    sys.path.insert(0, func_dir)

spec  = importlib.util.spec_from_file_location('user_handler', entry)
mod   = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
handler_fn = getattr(mod, 'handler', None)
print(f'Nova agent ready \u2014 loaded {entry}', flush=True)

class AgentHandler(BaseHTTPRequestHandler):
    def _handle(self):
        try:
            length   = int(self.headers.get('Content-Length', 0) or 0)
            raw_body = self.rfile.read(length) if length > 0 else b''
            parsed   = urllib.parse.urlparse(self.path)
            query    = dict(urllib.parse.parse_qsl(parsed.query))

            event = {
                'method':  self.command,
                'path':    parsed.path,
                'query':   query,
                'headers': dict(self.headers),
                'body':    raw_body.decode('utf-8', errors='replace') if raw_body else None,
                'json':    None,
            }
            if raw_body:
                try:
                    event['json'] = json.loads(raw_body)
                except Exception:
                    pass

            if not handler_fn:
                raise RuntimeError('No handler() function found in entry file: ' + entry)

            result = handler_fn(event)

            # Support { statusCode, body, headers } or plain return value
            if isinstance(result, dict) and 'statusCode' in result:
                status        = result['statusCode']
                out_body      = json.dumps(result.get('body', result)).encode()
                extra_headers = result.get('headers', {})
            else:
                status        = 200
                out_body      = json.dumps(result).encode()
                extra_headers = {}

            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            for k, v in extra_headers.items():
                self.send_header(k, v)
            self.send_header('Content-Length', len(out_body))
            self.end_headers()
            self.wfile.write(out_body)

        except Exception as exc:
            err = json.dumps({'error': str(exc), 'trace': traceback.format_exc()}).encode()
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', len(err))
            self.end_headers()
            self.wfile.write(err)

    # All HTTP methods route to the same handler
    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = _handle

    def log_message(self, *args): pass  # silence access log

if __name__ == '__main__':
    port = int(os.environ.get('NOVA_PORT', 8080))
    print(f'Nova HTTP agent listening on :{port}', flush=True)
    ThreadingHTTPServer(('0.0.0.0', port), AgentHandler).serve_forever()
`;

// ─── Nova Agent — Node.js ─────────────────────────────────────────────────────
const NOVA_AGENT_JS = `
const http = require('http');
const url  = require('url');

const entry = process.env.NOVA_ENTRY || '/function/handler.js';
const mod   = require(entry);
const handlerFn = mod.handler || mod.default || (typeof mod === 'function' ? mod : null);
console.log('Nova agent ready — loaded', entry);

const server = http.createServer(async (req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
        try {
            const raw    = Buffer.concat(chunks);
            const parsed = url.parse(req.url, true);
            let jsonBody = null;
            try { if (raw.length) jsonBody = JSON.parse(raw); } catch (_) {}

            const event = {
                method:  req.method,
                path:    parsed.pathname,
                query:   parsed.query,
                headers: req.headers,
                body:    raw.length ? raw.toString() : null,
                json:    jsonBody,
            };

            if (!handlerFn) throw new Error('No handler() export found in: ' + entry);
            const result = await handlerFn(event);

            let status = 200, out;
            if (result && typeof result === 'object' && 'statusCode' in result) {
                status = result.statusCode;
                out    = JSON.stringify(result.body !== undefined ? result.body : result);
            } else {
                out = JSON.stringify(result);
            }
            res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(out) });
            res.end(out);
        } catch (e) {
            const out = JSON.stringify({ error: e.message, stack: e.stack });
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(out);
        }
    });
});

const port = parseInt(process.env.NOVA_PORT || '8080');
server.listen(port, '0.0.0.0', () => console.log('Nova HTTP agent listening on 0.0.0.0:' + port));
`;

// ─── Dockerfiles ──────────────────────────────────────────────────────────────
/**
 * Generate a Dockerfile for the given runtime.
 * The nova_agent wraps the user's handler() — supports all HTTP methods.
 */
const DOCKERFILES = {
    python: (requirementsFile, entryPoint) => `FROM python:3.11-slim

WORKDIR /function

# Install dependencies
COPY ${requirementsFile} ./${requirementsFile}
RUN pip install --no-cache-dir -r ${requirementsFile}

# User code
COPY . /function/

# Nova HTTP agent — auto-generated, supports GET/POST/PUT/DELETE/etc
COPY nova_agent.py /nova_agent.py

# NOVA_ENTRY tells the agent which file contains handler()
ENV NOVA_ENTRY=/function/${entryPoint}
ENTRYPOINT ["python3", "/nova_agent.py"]
`,

    nodejs: (requirementsFile, entryPoint) => `FROM node:20-slim

WORKDIR /function

# Install dependencies
COPY ${requirementsFile} ./package.json
RUN npm install --omit=dev 2>/dev/null || true

# User code
COPY . /function/

# Nova HTTP agent
COPY nova_agent.js /nova_agent.js

ENV NOVA_ENTRY=/function/${entryPoint}
ENTRYPOINT ["node", "/nova_agent.js"]
`,

    php: (_req, entryPoint) => `FROM php:8.2-cli-slim

WORKDIR /function

COPY . /function/

ENV NOVA_ENTRY=/function/${entryPoint}
ENV NOVA_PORT=8080
CMD ["php", "-S", "0.0.0.0:8080", "/function/${entryPoint}"]
`,

    ruby: (reqFile, entryPoint) => `FROM ruby:3.2-slim

WORKDIR /function
COPY ${reqFile} ./${reqFile}
RUN bundle install || true

COPY . /function/
ENV NOVA_PORT=8080
CMD ["ruby", "/function/${entryPoint}"]
`,

    golang: (_reqFile, entryPoint) => `FROM golang:1.21-alpine

WORKDIR /function
COPY . .
RUN if [ -f go.mod ]; then go build -o main ${entryPoint}; else go build -o main ${entryPoint}; fi
ENV NOVA_PORT=8080
CMD ["./main"]
`,

    java: (_reqFile, entryPoint) => `FROM openjdk:17-slim

WORKDIR /function
COPY . /function/
ENV NOVA_PORT=8080
CMD ["java", "-jar", "/function/${entryPoint}"]
`,

    dotnet: (_reqFile, entryPoint) => `FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /source
COPY . .
RUN dotnet publish -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /app ./
ENV ASPNETCORE_URLS=http://+:8080
ENV NOVA_PORT=8080
CMD ["dotnet", "${entryPoint}"]
`,
};

// ─── buildFunctionImage ───────────────────────────────────────────────────────
/**
 * Build a container image for the given function on the specified worker.
 *
 * @param {object} worker        - { id, ip, username, password, ssh_port }
 * @param {object} opts
 * @param {string} opts.name           - function name (slug)
 * @param {string} opts.runtime        - 'python' | 'nodejs' | 'php'
 * @param {string} opts.entryPoint     - relative path within uploaded dir e.g. 'handler.py'
 * @param {string} opts.requirementsFile - relative path to deps file
 * @param {Array}  opts.files          - [{ name, content }]
 * @param {Function} opts.onLog        - (message, level?) => void
 */
async function buildFunctionImage(worker, opts, onLogArg) {
    const { name, runtime, entryPoint, requirementsFile, files } = opts;
    // onLog can come as 3rd positional arg (how deploy.js calls it) or inside opts
    const onLog = onLogArg || opts.onLog || (() => {});
    const tag      = `${REGISTRY_HOST}/nova-fn-${name}:latest`;
    const buildDir = `/opt/nova/build/${name}`;

    onLog(`🖥️  Using worker ${worker.ip} for build`, 'step');
    onLog(`🔧 Connecting to worker ${worker.ip}...`, 'step');

    // ── Try Worker API for file writes (no SSH) ────────────────────────────
    let useWorkerApi = false;
    try {
        const healthCheck = await workerApiClient.get(`http://${worker.ip}:${WORKER_API_PORT}/health`);
        if (healthCheck.data && healthCheck.data.containerd_ok) {
            useWorkerApi = true;
            onLog('⚡ Using Worker API for file transfers', 'step');
        }
    } catch (_) {
        onLog('🔧 Worker API unavailable — using SSH for all operations', 'step');
    }

    // SSH connection (needed for streaming build output and as fallback)
    const ssh = await createSSHClient({
        ip:       worker.ip,
        username: worker.username,
        password: worker.password,
        port:     worker.ssh_port,
    });

    try {
        // ── 1. Create clean build directory ───────────────────────────────────
        onLog(`📁 Creating build directory ${buildDir}`, 'step');
        await remoteRun(worker, ssh, `rm -rf ${buildDir} && mkdir -p ${buildDir}`, onLog);

        // ── 2. Upload user files ───────────────────────────────────────────────
        onLog(`📦 Uploading ${files.length} file(s)...`, 'step');
        for (const file of files) {
            const relativePath = file.name.replace(/\\/g, '/');
            const remotePath   = `${buildDir}/${relativePath}`;
            const dir          = remotePath.substring(0, remotePath.lastIndexOf('/'));
            if (dir !== buildDir) await remoteRun(worker, ssh, `mkdir -p ${dir}`, onLog);
            onLog(`  ↳ ${relativePath}`, 'info');
            await writeRemote(worker, ssh, remotePath, file.content, onLog);
        }

        // ── 3. Write nova_agent (HTTP wrapper for all methods) ─────────────────
        if (runtime === 'python' || runtime === 'nodejs') {
            const agentFile    = runtime === 'nodejs' ? 'nova_agent.js'   : 'nova_agent.py';
            const agentContent = runtime === 'nodejs' ? NOVA_AGENT_JS : NOVA_AGENT_PY;
            onLog(`📝 Writing ${agentFile} (HTTP agent, all methods)`, 'step');
            await writeRemote(worker, ssh, `${buildDir}/${agentFile}`, agentContent, onLog);
        }

        // ── 4. Ensure a requirements/deps file exists ──────────────────────────
        const defaultReq = {
            nodejs: 'package.json',
            ruby: 'Gemfile',
            golang: 'go.mod',
            php: 'composer.json',
            python: 'requirements.txt'
        };
        const reqFile = requirementsFile || defaultReq[runtime] || 'requirements.txt';
        const uploadedNames = files.map(f => f.name.replace(/\\/g, '/'));
        const reqExists = uploadedNames.includes(reqFile);

        if (!reqExists && (runtime === 'python' || runtime === 'nodejs' || runtime === 'ruby')) {
            let emptyContent = '';
            if (runtime === 'nodejs') emptyContent = '{"name":"function","version":"1.0.0","dependencies":{}}';
            else if (runtime === 'ruby') emptyContent = 'source "https://rubygems.org"\n';
            else emptyContent = '# no dependencies\n';

            onLog(`📝 No ${reqFile} found — writing empty placeholder`, 'step');
            await writeRemote(worker, ssh, `${buildDir}/${reqFile}`, emptyContent, onLog);
        }

        // ── 5. Write Dockerfile ────────────────────────────────────────────────
        onLog('📝 Writing Dockerfile', 'step');
        const dockerfileGen     = DOCKERFILES[runtime] || DOCKERFILES.python;
        const dockerfileContent = dockerfileGen(reqFile, entryPoint);
        await writeRemote(worker, ssh, `${buildDir}/Dockerfile`, dockerfileContent, onLog);

        // ── 6. Verify build context ────────────────────────────────────────────
        onLog('🔍 Build context:', 'step');
        await remoteRun(worker, ssh, `find ${buildDir} -type f | sed 's|${buildDir}/||'`, onLog);

        // ── 7. Build OCI image ─────────────────────────────────────────────────
        // Keep SSH streaming for build output (important for UX)
        onLog(`🐳 Building image ${tag}...`, 'step');
        await sshRunStream(ssh, `nerdctl build --insecure-registry --no-cache --namespace default -t ${tag} ${buildDir} 2>&1`, onLog);

        // ── 7b. Verify image exists ────────────────────────────────────────────
        onLog('✅ Verifying image...', 'step');
        const imgCheck = await ssh.exec(`nerdctl images --namespace default | grep nova-fn-${name}`);
        if (imgCheck.code !== 0 || !imgCheck.stdout.includes(`nova-fn-${name}`)) {
            throw new Error(`Image ${tag} not found after build.`);
        }
        onLog(`✅ Image ${tag} ready!`, 'step');

        // ── 8. Push to local registry so other workers can pull ────────────────
        onLog(`📤 Pushing ${tag} to local registry...`, 'step');
        try {
            await remoteRun(worker, ssh, `nerdctl push --insecure-registry ${tag} 2>&1`, onLog);
            onLog(`✅ Image pushed to registry`, 'step');
        } catch (pushErr) {
            onLog(`⚠️  Push failed (image only available on this worker): ${pushErr.message}`, 'warn');
            logger.warn(`Push to registry failed for ${tag}: ${pushErr.message}`);
        }

        return { image: tag };

    } finally {
        ssh.close();
    }
}

// ─── deleteFunction ───────────────────────────────────────────────────────────
/**
 * Stop all containers for a function, remove the image, and clean up the build dir.
 *
 * @param {object} worker    - { ip, username, password, ssh_port }
 * @param {string} funcName  - function slug (e.g. 'my-func')
 * @param {string[]} containerNames - list of container names to stop/remove
 */
async function deleteFunctionResources(worker, funcName, containerNames = []) {
    const tag      = `${REGISTRY_HOST}/nova-fn-${funcName}:latest`;
    const buildDir = `/opt/nova/build/${funcName}`;

    // ── Try Worker API for stop operations ────────────────────────────────
    for (const name of containerNames) {
        logger.info(`[delete:${funcName}] Stopping container ${name}`);
        try {
            await workerApiClient.post(`http://${worker.ip}:${WORKER_API_PORT}/stop`, { container_name: name });
        } catch (_) {
            // Fall through to SSH below
        }
    }

    const ssh = await createSSHClient({
        ip:       worker.ip,
        username: worker.username,
        password: worker.password,
        port:     worker.ssh_port,
    });

    try {
        // Stop & remove any containers that Worker API didn't handle
        for (const name of containerNames) {
            await ssh.exec(`nerdctl stop ${name} 2>/dev/null || true`);
            await ssh.exec(`nerdctl rm   ${name} 2>/dev/null || true`);
        }

        // Also force-remove any stray containers using this image
        await ssh.exec(`nerdctl ps -a --filter "ancestor=${tag}" -q | xargs -r nerdctl rm -f 2>/dev/null || true`);

        // Remove the image
        logger.info(`[delete:${funcName}] Removing image ${tag}`);
        await ssh.exec(`nerdctl rmi ${tag} 2>/dev/null || true`);

        // Clean up build directory
        logger.info(`[delete:${funcName}] Removing build directory ${buildDir}`);
        await ssh.exec(`rm -rf ${buildDir}`);

        logger.info(`[delete:${funcName}] ✅ All resources removed`);
    } finally {
        ssh.close();
    }
}

// ─── Remote execution helpers (Worker API first, SSH fallback) ────────────────

/** Run a command via Worker API or SSH. */
async function remoteRun(worker, ssh, command, onLog) {
    // Try Worker API first
    try {
        const response = await workerApiClient.post(
            `http://${worker.ip}:${WORKER_API_PORT}/exec`,
            { command, timeout: 30000 }
        );
        if (response.data && response.data.success) {
            if (response.data.stdout) onLog(response.data.stdout, 'info');
            if (response.data.stderr) onLog(response.data.stderr, 'info');
            return { code: 0, stdout: response.data.stdout, stderr: response.data.stderr };
        }
    } catch (_) {}

    // Fallback: SSH
    return sshRun(ssh, command, onLog);
}

/** Write a file via Worker API or SSH. */
async function writeRemote(worker, ssh, remotePath, content, onLog) {
    // Try Worker API first
    try {
        const content_base64 = Buffer.from(content).toString('base64');
        const response = await workerApiClient.post(
            `http://${worker.ip}:${WORKER_API_PORT}/write-file`,
            { path: remotePath, content_base64 }
        );
        if (response.data && response.data.success) return;
    } catch (_) {}

    // Fallback: SSH
    return writeRemoteFile(ssh, remotePath, content, onLog);
}

// ─── SSH helpers ──────────────────────────────────────────────────────────────

/** Run a command and log its output. Throws on non-zero exit. */
async function sshRun(ssh, command, onLog) {
    const result = await ssh.exec(command);
    if (result.stdout) onLog(result.stdout, 'info');
    if (result.stderr) onLog(result.stderr, 'info');
    if (result.code !== 0) {
        throw new Error(`Command failed (exit ${result.code}): ${command}\n${result.stderr || result.stdout}`);
    }
    return result;
}

/**
 * Write a file on the remote host safely using base64 encoding.
 * Avoids heredoc quoting issues with arbitrary content.
 */
async function writeRemoteFile(ssh, remotePath, content, onLog) {
    const encoded  = Buffer.from(content).toString('base64');
    const chunkSize = 2000;
    const chunks   = [];
    for (let i = 0; i < encoded.length; i += chunkSize) {
        chunks.push(encoded.slice(i, i + chunkSize));
    }

    const firstResult = await ssh.exec(`echo '${chunks[0]}' > /tmp/_nova_b64`);
    if (firstResult.code !== 0) throw new Error(`Failed to write chunk 0 for ${remotePath}`);

    for (let i = 1; i < chunks.length; i++) {
        const r = await ssh.exec(`echo '${chunks[i]}' >> /tmp/_nova_b64`);
        if (r.code !== 0) throw new Error(`Failed to write chunk ${i} for ${remotePath}`);
    }

    const decodeResult = await ssh.exec(`base64 -d /tmp/_nova_b64 > ${remotePath} && rm /tmp/_nova_b64`);
    if (decodeResult.code !== 0) {
        throw new Error(`Failed to decode to ${remotePath}: ${decodeResult.stderr}`);
    }
}

/**
 * Run a long command and stream each line of output via onLog.
 */
async function sshRunStream(ssh, command, onLog) {
    return new Promise((resolve, reject) => {
        ssh.raw.exec(command, (err, stream) => {
            if (err) return reject(err);

            let buffer = '';
            const flushLine = (chunk) => {
                buffer += chunk;
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines) {
                    if (line.trim()) onLog(line, 'info');
                }
            };

            stream
                .on('close', (code) => {
                    if (buffer.trim()) onLog(buffer, 'info');
                    if (code !== 0) return reject(new Error(`Build exited with code ${code}`));
                    resolve();
                })
                .on('data',  (data) => flushLine(data.toString()))
                .stderr.on('data', (data) => flushLine(data.toString()));
        });
    });
}

module.exports = { buildFunctionImage, deleteFunctionResources };
