import { createProxyMiddleware } from 'http-proxy-middleware';
import logger from '../utils/logger.js';
import { logTiming } from '../utils/timingLogger.js';
import axios from 'axios';

const proxyMiddleware = createProxyMiddleware({
    router: (req) => {
        return req.vmTarget;
    },
    target: "http://localhost",
    changeOrigin: false,
    ws: true,
    on: {
        proxyReq: (proxyReq, req, res) => {
            if (req.requestId) {
                proxyReq.setHeader('X-Nova-Request-Id', req.requestId);
            }
            logTiming(req.requestId, 'proxy_request_sent', performance.now() - req.startTime, {
                vmTarget: req.vmTarget,
                method: req.method,
                url: req.url,
            });
        },
        proxyRes: (proxyRes, req, res) => {
            const elapsed = performance.now() - req.startTime;
            logTiming(req.requestId, 'proxy_response_received', elapsed, {
                vmTarget: req.vmTarget,
                statusCode: proxyRes.statusCode,
            });
            // Log invocation asynchronously
            if (req.functionData && req.containerId) {
                const PLACEMENT_URL = process.env.PLACEMENT_SERVICE_URL || 'http://localhost:3002';
                axios.post(`${PLACEMENT_URL}/invocations`, {
                    function_id: req.functionData.id,
                    container_id: req.containerId,
                    status_code: proxyRes.statusCode,
                    latency_ms: Math.round(elapsed),
                    request_method: req.method,
                    request_path: req.url
                }).catch(err => logger.error(`Failed to log invocation: ${err.message}`));
            }
        },
        error: (err, req, res) => {
            logTiming(req.requestId, 'proxy_error', performance.now() - req.startTime, {
                vmTarget: req.vmTarget,
                error: err.message,
                errorCode: err.code,
            });
            logger.error(`Proxy Error: ${err.message}`);
            if (!res.headersSent) {
                res.status(502).json({ error: "bad gateway" });
            }
        }
    }
});

export default proxyMiddleware;
