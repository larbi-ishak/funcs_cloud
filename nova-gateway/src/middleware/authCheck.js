import { apiKeys } from '../db/database.js';
import { logTiming } from '../utils/timingLogger.js';

export default function authCheck(req, res, next) {
    const t0 = performance.now();
    const { functionData } = req;

    if (functionData.auth_policy === 'public') {
        logTiming(req.requestId, 'authCheck_done', performance.now() - req.startTime, {
            policy: 'public', step_ms: +(performance.now() - t0).toFixed(2),
        });
        return next();
    }

    if (functionData.auth_policy === 'private') {
        const token = req.headers['authorization'] || req.headers['x-api-key'];
        
        if (!token) {
            logTiming(req.requestId, 'authCheck_rejected', performance.now() - req.startTime, {
                reason: 'no_token', step_ms: +(performance.now() - t0).toFixed(2),
            });
            return res.status(401).json({ error: "authentication required" });
        }

        const keyData = apiKeys.findByKey(token);
        if (!keyData || keyData.function_id !== functionData.id) {
            logTiming(req.requestId, 'authCheck_rejected', performance.now() - req.startTime, {
                reason: 'invalid_key', step_ms: +(performance.now() - t0).toFixed(2),
            });
            return res.status(401).json({ error: "invalid api key" });
        }

        logTiming(req.requestId, 'authCheck_done', performance.now() - req.startTime, {
            policy: 'private', step_ms: +(performance.now() - t0).toFixed(2),
        });
        return next();
    }
    
    return res.status(500).json({ error: "unknown auth policy" });
}
