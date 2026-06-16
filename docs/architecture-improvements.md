# Architecture Improvements — Nova Kata

> **Status:** Items 1-6 and 8-10 done. Item 7 replaced by round-robin analysis (see gateway-improvements.md).
> **Created:** 2026-06-13
> **Updated:** 2026-06-16

---

## 1. Orphan Warm Pool Cleanup (Self-Healing) ✅ Done

### The Problem

When a worker VM disappears (crash, GCP deletion, network partition) without calling `DELETE /workers/:id`, its warm pool entries and container records remain in the database forever. The gateway then tries to route traffic to dead containers.

### The Fix

Added orphan detection to the monitoring cycle (`monitoringService.js`). Every 30s, after health checks:

1. Find warm pool entries where worker is FAULTY or RETIRED → delete them
2. Find containers where worker is FAULTY or RETIRED → mark as `failed`
3. Find entries referencing workers that don't exist at all → clean up

**Effort**: ~1 hour

---

## 2. Shared Container Registry ✅ Done

### The Problem

Each worker runs its own `localhost:5000` registry. Images are local to the worker that built them. If Worker A dies, all its images are lost.

### The Fix

Implemented shared registry via `REGISTRY_HOST` env var. Images are pushed to the shared registry and pulled by any worker.

---

## 3. ThreadingHTTPServer for Python Agent ✅ Done

Changed `HTTPServer` → `ThreadingHTTPServer` in `nova-kata/src/services/buildService.js`. One thread per request — concurrent handling.

---

## 4. Single-Flight Lock for Cold Starts ✅ Done

Added `pendingClaims` Map in `nova-kata-gateway/src/middleware/containerStateCheck.js`. First request fires the claim, other concurrent requests await the same Promise. On failure: returns 503 + `Retry-After: 2`.

---

## 5. Round-Robin Container Pool Routing ✅ Done

Changed cache from `{ host_ip, host_port }` to `{ containers: [...], nextIndex: 0 }`. Each request picks the next container: A → B → C → A → B → C.

Round-robin is the correct routing strategy for Nova. For homogeneous servers with low-variance service times and small server counts (2–5 workers, 10–50 containers), round-robin performs within a few percent of optimal adaptive policies. The overhead of adaptive load sharing (monitoring, state exchange) exceeds the benefit at this scale. See `docs/gateway-improvements.md` for the full research-backed analysis with references.

---

## 6. Auto-Delete Faulty Workers + PENDING Registration ✅ Done

**A — Auto-delete**: When `consecutive_failures >= MAX_CONSECUTIVE_FAILURES`, delete warm pool entries, containers, and the worker row.

**B — PENDING registration**: When `initWorker()` SSH fails, insert worker with `status: 'pending'`. Health check retries validation every 30s.

---

## 7. Load-Aware Pool Scaling — Not Needed

Round-robin with the warm pool already provides efficient load distribution. Load-aware scaling (request rate tracking, concurrency counters, scale-up/down manager) would add ~150 lines of code for negligible benefit at Nova's scale. The warm pool replenish cycle (`WARM_POOL_REPLENISH_INTERVAL_MS=15000`) already adapts pool size based on `WARM_POOL_MIN`/`WARM_POOL_MAX` configuration.

See `docs/gateway-improvements.md` for the research-backed analysis proving round-robin is near-optimal for homogeneous serverless systems.

---

## 8. Worker API — HTTP Agent on Worker VMs ✅ Done

Deployed a lightweight Express HTTP server (`nova-kata/worker-api/`) on each worker VM. Latency saved: ~70-170ms per pause/unpause operation vs SSH.

---

## 9. Nginx Removal — Direct Port Mapping ✅ Done

Replaced nginx with nerdctl's built-in `-p` port mapping (iptables/NAT). Simpler provisioning, no config file management, no reload thrashing risk.

---

## 10. Direct Node.js Binary — No NodeSource ✅ Done

Download Node.js binary tarball directly from nodejs.org. No apt repo, no GPG issues, deterministic version.

---

## Per-Function Resource Quotas

`--memory` and `--cpus` flags are already passed to `nerdctl run` in `containerService.js` (lines 159-160). Values come from the function's `memory_limit` (MB) and `cpu_limit` fields in the database, which are set from user input in the dashboard deploy form. The frontend enforces limits on these values.

```js
const memoryLimit = options.memory_limit ? `--memory ${options.memory_limit}m` : '';
const cpuLimit = options.cpu_limit ? `--cpus ${options.cpu_limit}` : '';
```

---

## Future Work

| Feature | Rationale | Complexity |
|---|---|---|
| Multi-region function deployment | Workers in one region at a time | High — cross-region networking + state sync |
| Billing/metering | No usage tracking | High — invocation counting + pricing model |
| CI/CD pipeline | No automated testing or deployment | Medium — GitHub Actions + integration tests |
| Container image vulnerability scanning | No Trivy/Grype integration | Low — post-build scan step |

---

## Summary

| Issue | Impact | Effort | Status |
|---|---|---|---|
| 1. Orphan warm pool cleanup + monitoring | Medium (self-healing) | ~1 hour | ✅ Done |
| 2. Shared registry | High (scalability blocker) | ~2-4 hours | ✅ Done |
| 3. ThreadingHTTPServer | Medium (Python concurrency) | 2 lines | ✅ Done |
| 4. Single-flight lock | High (prevents worker crash) | ~5 lines | ✅ Done |
| 5. Round-robin pool routing | Medium (load distribution) | ~30 lines | ✅ Done |
| 6. Auto-delete + PENDING registration | High (worker lifecycle) | ~30 lines | ✅ Done |
| 7. Load-aware pool scaling | — | — | Not needed (round-robin sufficient) |
| 8. Worker API (HTTP agent on workers) | High (latency: -70-170ms/op) | ~3 hours | ✅ Done |
| 9. Nginx removal (direct port mapping) | Medium (simpler, faster) | ~1 hour | ✅ Done |
| 10. Direct Node.js binary (no NodeSource) | Medium (reliable provisioning) | ~30 min | ✅ Done |