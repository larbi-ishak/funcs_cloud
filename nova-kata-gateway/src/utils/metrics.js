import promClient from 'prom-client';

// ── Prometheus Registry ──────────────────────────────────────────────────────
const register = new promClient.Registry();

// Default Node.js metrics: CPU, memory, GC, event loop lag
promClient.collectDefaultMetrics({ register });

// ── Custom Metrics ───────────────────────────────────────────────────────────

/** Request duration histogram — tracks latency per function and status code */
const requestDuration = new promClient.Histogram({
    name: 'nova_request_duration_seconds',
    help: 'Request duration in seconds',
    labelNames: ['function', 'status_code', 'method'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [register],
});

/** Cache hit counter — tracks fn (function) and ct (container) cache hits */
const cacheHits = new promClient.Counter({
    name: 'nova_cache_hits_total',
    help: 'Cache hit count',
    labelNames: ['type'],  // 'fn' or 'ct'
    registers: [register],
});

/** Warm pool size gauge — set periodically by the gateway */
const warmPoolSize = new promClient.Gauge({
    name: 'nova_warm_pool_size',
    help: 'Current warm pool size',
    registers: [register],
});

/** Rate limit counter — tracks how many requests were throttled */
const rateLimited = new promClient.Counter({
    name: 'nova_rate_limited_total',
    help: 'Number of rate-limited requests',
    labelNames: ['limiter'],  // 'ip' or 'function'
    registers: [register],
});

export { register, requestDuration, cacheHits, warmPoolSize, rateLimited };