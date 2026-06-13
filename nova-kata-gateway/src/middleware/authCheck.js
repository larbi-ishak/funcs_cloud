import { apiKeys } from '../db/database.js';

export default function authCheck(req, res, next) {
    const t0 = performance.now();
    const { functionData } = req;

    // Guard: existenceCheck must set req.functionData before this middleware runs
    if (!functionData) {
        return res.status(500).json({ error: "function data missing" });
    }

    if (functionData.auth_policy === 'public') {
        req.log.info({
            elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
            policy: 'public', step_ms: +(performance.now() - t0).toFixed(2),
        }, 'authCheck_done');
        return next();
    }

    if (functionData.auth_policy === 'private') {
        const token = req.headers['authorization'] || req.headers['x-api-key'];

        if (!token) {
            req.log.info({
                elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
                reason: 'no_token', step_ms: +(performance.now() - t0).toFixed(2),
            }, 'authCheck_rejected');
            return res.status(401).json({ error: "authentication required" });
        }

        // Single atomic DB check: key must exist AND belong to this function
        const keyData = apiKeys.findByKeyAndFunction(token, functionData.id);
        if (!keyData) {
            req.log.info({
                elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
                reason: 'invalid_key', step_ms: +(performance.now() - t0).toFixed(2),
            }, 'authCheck_rejected');
            return res.status(401).json({ error: "invalid api key" });
        }

        req.log.info({
            elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
            policy: 'private', step_ms: +(performance.now() - t0).toFixed(2),
        }, 'authCheck_done');
        return next();
    }

    return res.status(500).json({ error: "unknown auth policy" });
}
