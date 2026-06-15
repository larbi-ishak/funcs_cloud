# Gateway Improvements — Nova Kata Gateway

> **Status:** Items 1-11 and 13-16 done. Items 12 and 17 removed (not needed).
> **Created:** 2026-06-13
> **Updated:** 2026-06-13

---

## Completed Fixes

| # | Issue | Severity | Type | Status |
|---|---|---|---|---|
| 1 | Cache expiry never releases containers in pool | 🔴 Critical | Bug | ✅ Done |
| 2 | Redis expiry tracking broken for pool format | 🔴 Critical | Bug | ✅ Done |
| 3 | No proxy timeout | 🔴 High | Bug | ✅ Done |
| 4 | Internal server binds 127.0.0.1 only | 🔴 High | Bug | ✅ Done |
| 5 | Auth DB query on every private request | 🟡 Medium | Performance | ✅ Done |
| 7 | No health check endpoint | 🟡 Medium | Ops | ✅ Done |
| 8 | No graceful drain on shutdown | 🟡 Medium | Reliability | ✅ Done |
| 9 | Invocation buffer can lose data on crash | 🟢 Low | Data | ✅ Done |
| 10 | No CORS headers | 🟡 Medium | Feature | ✅ Done |

---

## Implemented Improvements

### 11. Rate Limiting ✅ Done

**Severity:** 🟡 Medium (Security)

Per-IP rate limit (100 req/s) + per-function rate limit (50 req/s) using `express-rate-limit`. Returns `429 Too Many Requests` with `RateLimit-*` standard headers. Rate-limited requests tracked in Prometheus `nova_rate_limited_total` counter.

**Env vars:** `RATE_LIMIT_PER_SEC=100`, `FUNCTION_RATE_LIMIT=50`

---

### 13. Pre-Warm Container Cache on Startup ✅ Done

**Severity:** 🟢 Low (Optimization)

On startup, after pre-warming function cache, also loads running containers per function into the cache. First requests after restart are cache hits instead of DB queries (~5ms saved).

---

### 14. `/metrics` Endpoint for Observability ✅ Done

**Severity:** 🟢 Low (Observability)

Prometheus-style metrics endpoint on the internal server (port 3003). Includes:
- Default Node.js metrics (CPU, memory, GC, event loop lag)
- `nova_request_duration_seconds` histogram (by function, status code, method)
- `nova_cache_hits_total` counter (by type: fn/ct)
- `nova_warm_pool_size` gauge
- `nova_rate_limited_total` counter (by limiter: ip/function)

**Endpoint:** `GET http://localhost:3003/metrics`

---

### 15. Compress Proxy Responses ✅ Done

**Severity:** 🟢 Low (Optimization)

Compression middleware with `threshold: 1024` (only compress >1KB). Proxied responses are not double-compressed — the backend container decides.

---

### 16. Request Timeout Middleware ✅ Done

**Severity:** 🟢 Low (Reliability)

Global request timeout (default 60s). Safety net that kills requests if `proxyTimeout` is misconfigured. Returns `504 Gateway Timeout`.

**Env var:** `REQUEST_TIMEOUT_MS=60000`

---

## Summary

| # | Issue | Severity | Type | Effort | Status |
|---|---|---|---|---|---|
| 1-10 | See completed fixes above | Various | Various | — | ✅ Done |
| 11 | Rate limiting | 🟡 Medium | Security | ~15 min | ✅ Done |
| 12 | Round-robin race condition | 🟢 Low | Bug | — | Removed (negligible) |
| 13 | Pre-warm container cache | 🟢 Low | Optimization | ~30 min | ✅ Done |
| 14 | `/metrics` endpoint | 🟢 Low | Observability | ~1 hour | ✅ Done |
| 15 | Compress proxy responses | 🟢 Low | Optimization | ~15 min | ✅ Done |
| 16 | Request timeout middleware | 🟢 Low | Reliability | ~5 min | ✅ Done |
| 17 | Pool-aware cache expiry | 🟢 Low | Optimization | — | Removed (not needed) |
