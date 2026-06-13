/**
 * Resolves the target function name from the incoming request.
 *
 * Supports two patterns (checked in order):
 *
 *  1. Path-based  — works locally with zero config:
 *       http://localhost:8081/fn/<name>/optional/path
 *       req.url is rewritten to /optional/path (or /) before forwarding.
 *
 *  2. Subdomain-based — production + local simulation:
 *       http://<name>.localhost:8081        (add to hosts: 127.0.0.1 <name>.localhost)
 *       http://<name>.example.com:8081
 *       req.url is left untouched.
 *
 * Sets req.functionName (and req.region for subdomain mode).
 */
function parseHost(req, res, next) {
    const t0 = performance.now();

    // ── 1. Path-based: /fn/<name>[/...] ──────────────────────────────────────
    const pathMatch = req.path.match(/^\/fn\/([a-z0-9][a-z0-9-]*)(\/.*)?$/i);
    if (pathMatch) {
        req.functionName = pathMatch[1].toLowerCase();
        req.region       = 'local';
        // Rewrite URL so the upstream container sees / instead of /fn/<name>/
        req.url = pathMatch[2] || '/';

        req.log.info({
            elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
            mode:         'path',
            functionName: req.functionName,
            step_ms:      +(performance.now() - t0).toFixed(2),
        }, 'parseHost_done');
        return next();
    }

    // ── 2. Subdomain-based: <name>.<tld>[:<port>] ────────────────────────────
    const rawHost = req.headers.host || '';
    const hostWithoutPort = rawHost.split(':')[0];   // strip :8081
    const parts = hostWithoutPort.split('.');

    // Need at least <name>.<tld> — reject bare "localhost" with no subdomain
    if (parts.length >= 2 && parts[0] !== '' && parts[0] !== 'www') {
        req.functionName = parts[0].toLowerCase();
        req.region       = parts.slice(1).join('.');

        req.log.info({
            elapsed_ms: +(performance.now() - req.startTime).toFixed(2),
            mode:         'subdomain',
            functionName: req.functionName,
            region:       req.region,
            step_ms:      +(performance.now() - t0).toFixed(2),
        }, 'parseHost_done');
        return next();
    }

    return res.status(404).json({
        error: 'Function name required.',
        hint:  'Use path format: /fn/<name> — or subdomain format: <name>.localhost',
    });
}

export default parseHost;
