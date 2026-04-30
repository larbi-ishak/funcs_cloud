import { logTiming } from '../utils/timingLogger.js';

function parseHost(req, res, next) {
    const t0 = performance.now();
    let host = req.headers.host;
    // NOTE: host is hardcoded for local dev testing
    host = "test.dz";
    if (!host) {
        return res.status(404).json({ error: "missing function name" });
    }

    const parts = host.split('.');
    if (parts.length < 2) {
        return res.status(404).json({ error: "missing function name" });
    }

    req.functionName = parts[0];
    req.region = parts[1];

    const elapsed = performance.now() - req.startTime;
    logTiming(req.requestId, 'parseHost_done', elapsed, {
        functionName: req.functionName,
        region: req.region,
        step_ms: +(performance.now() - t0).toFixed(2),
    });

    next();
}

export default parseHost;
