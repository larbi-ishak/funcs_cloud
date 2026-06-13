import { createProxyMiddleware } from 'http-proxy-middleware';
import logger from '../utils/logger.js';
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
                }).catch(err => logger.error({ err }, 'Failed to log invocation'));
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
