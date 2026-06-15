import { createProxyMiddleware } from 'http-proxy-middleware';
import logger from '../utils/logger.js';
import axios from 'axios';
import http from 'http';
import { requestDuration } from '../utils/metrics.js';

const PLACEMENT_URL = process.env.PLACEMENT_SERVICE_URL || 'http://localhost:3002';
const PROXY_TIMEOUT_MS = parseInt(process.env.PROXY_TIMEOUT_MS) || 30000;

// Reuse TCP connections to containers (keep-alive) instead of opening a new
// socket per request. Saves ~1-5ms TCP handshake per proxied request and
// prevents ephemeral port exhaustion under high load.
const proxyAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 100,
});

// ── Batch invocation logging ──────────────────────────────────────────────
// Instead of POSTing to the placement service for every single request,
// buffer invocations in memory and flush as a batch every 1 second.
// Reduces placement service load by 100-1000× under high traffic.
const invocationBuffer = [];
const MAX_BUFFER_SIZE = 10000;

function flushInvocationBuffer() {
    if (invocationBuffer.length === 0) return;
    const batch = [...invocationBuffer];
    invocationBuffer.length = 0;
    axios.post(`${PLACEMENT_URL}/invocations/batch`, { invocations: batch })
        .catch(err => logger.error({ err }, 'Failed to log invocation batch'));
}

setInterval(flushInvocationBuffer, 1000).unref();

// Flush remaining invocations on shutdown
process.on('SIGTERM', flushInvocationBuffer);
process.on('SIGINT', flushInvocationBuffer);

const proxyMiddleware = createProxyMiddleware({
    router: (req) => {
        return req.vmTarget;
    },
    target: "http://localhost",
    changeOrigin: false,
    ws: true,
    agent: proxyAgent,
    proxyTimeout: PROXY_TIMEOUT_MS,
    timeout: PROXY_TIMEOUT_MS + 5000,
    on: {
        proxyReq: (proxyReq, req, res) => {
            if (req.requestId) {
                proxyReq.setHeader('X-Nova-Request-Id', req.requestId);
            }
            req.log.info({
                elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
                vmTarget: req.vmTarget,
                method: req.method,
                url: req.url,
            }, 'proxy_request_sent');
        },
        proxyRes: (proxyRes, req, res) => {
            const elapsed = performance.now() - req.startTime;
            req.log.info({
                elapsed_ms: +elapsed.toFixed(2),
                vmTarget: req.vmTarget,
                statusCode: proxyRes.statusCode,
            }, 'proxy_response_received');
            // Record Prometheus metric
            const fnName = (req.functionData && req.functionData.name) || 'unknown';
            requestDuration.labels(fnName, String(proxyRes.statusCode), req.method).observe(elapsed / 1000);
            // Buffer invocation for batch logging (flushed every 1s)
            if (req.functionData && req.containerId) {
                if (invocationBuffer.length < MAX_BUFFER_SIZE) {
                    invocationBuffer.push({
                        function_id: req.functionData.id,
                        container_id: req.containerId,
                        status_code: proxyRes.statusCode,
                        latency_ms: Math.round(elapsed),
                        request_method: req.method,
                        request_path: req.url
                    });
                }
            }
        },
        error: (err, req, res) => {
            req.log.info({
                elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
                vmTarget: req.vmTarget,
                error: err.message,
                errorCode: err.code,
            }, 'proxy_error');
            logger.error({ err }, 'Proxy Error');
            if (!res.headersSent) {
                res.status(502).json({ error: "bad gateway" });
            }
        }
    }
});

export default proxyMiddleware;
