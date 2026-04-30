import { createProxyMiddleware } from 'http-proxy-middleware';
import logger from '../utils/logger.js';
import { logTiming } from '../utils/timingLogger.js';

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
            logTiming(req.requestId, 'proxy_response_received', performance.now() - req.startTime, {
                vmTarget: req.vmTarget,
                statusCode: proxyRes.statusCode,
            });
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

