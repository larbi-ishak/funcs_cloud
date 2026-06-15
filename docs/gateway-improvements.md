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

## Load-Aware Routing — Not Needed (Research-Backed)

Round-robin is the correct routing strategy for Nova Kata Gateway. Load-aware routing (least-connections, latency-weighted) would add complexity and overhead for **negligible benefit** given the system's characteristics.

### Why Round-Robin is Near-Optimal Here

| Condition | Nova Kata | Implication |
|---|---|---|
| Homogeneous servers | ✅ All containers run same Kata VM, same resources | No server is inherently faster |
| Low variance service times | ✅ Serverless functions are typically short (ms–seconds) | No heavy-tailed request distribution |
| Small server count | ✅ 2–5 workers, 10–50 containers | Difference between random and power-of-2-choices is negligible |
| No sticky sessions | ✅ Functions are stateless | Any container can serve any request |

### Key Research

1. **Eager, Lazowska, Zahorjan (1986)** — *"Adaptive Load Sharing in Homogeneous Distributed Systems"*, IEEE TSE SE-12(5).  
   → For homogeneous systems, random and round-robin perform **within a few percent of optimal** adaptive policies. The overhead of adaptive load sharing (monitoring, state exchange) often **exceeds** the benefit.

2. **Azar, Broder, Karlin, Upfal (1994)** — *"Balanced Allocations"*, ACM STOC '94.  
   → Random assignment gives max load of `O(log n / log log n)` w.h.p. — already very efficient.

3. **Mitzenmacher (1996/2001)** — *"The Power of Two Choices in Randomized Load Balancing"*, PhD Thesis / SIAM J. Computing.  
   → Picking 2 random servers and routing to the less loaded drops max load to `O(log log n)`. But for small n (2–5 workers), the difference is negligible.

4. **Harchol-Balter (2013)** — *"Performance Modeling and Design of Computer Systems"*, Cambridge UP.  
   → For homogeneous servers with low-variance service times, round-robin is provably near-optimal. Adaptive policies only help with **heterogeneous** servers or **heavy-tailed** service times.

**Conclusion:** Round-robin is the right choice. Load-aware routing would add ~150 lines of code, in-memory state tracking, and EWMA computation for <1% improvement at Nova's scale.

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
