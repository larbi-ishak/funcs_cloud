# Nova-Kata Control Plane — Security & Architecture Audit

> **Created:** 2026-06-14
> **Updated:** 2026-06-16 — Trimmed to resolved items only. Future work moved to thesis-codebase-context.md.
> **Scope:** Full deep-dive of nova-kata placement service, worker API, and database layer

---

## ✅ Fixed Issues

### 1. Double-Claim Race Condition in `warmPool.claimOne()` — FIXED
**Severity:** 🔴 Critical
**File:** `src/db/database.js`

**Problem:** `SELECT` + `UPDATE` were two separate, non-transactional statements. Under concurrent requests, two callers could both `SELECT` the same 'warm' row before either `UPDATE`s it.

**Fix:** Wrapped in `db.transaction()` to make the SELECT+UPDATE atomic. PostgreSQL migration uses `SELECT ... FOR UPDATE SKIP LOCKED`.

---

### 2. Shell Injection via Environment Variables in `containerService.js` — FIXED
**Severity:** 🔴 Critical
**File:** `src/services/containerService.js` — `launchContainer()`

**Fix — 4 layers of defense:**
1. Validate env var keys — `ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/`
2. Shell-escape values — `shellEscape()` wraps in single quotes
3. Whitelist the runtime — `ALLOWED_RUNTIMES = ['io.containerd.kata.v2', 'io.containerd.runc.v2']`
4. Validate numeric fields — `memory_limit` and `cpu_limit` must be positive numbers

---

### 3. Shell Injection in Worker API (`worker-api/index.js`) — FIXED
**Severity:** 🔴 Critical
**File:** `worker-api/index.js`

**Fix:** Switched `pause`, `unpause`, and `stop` endpoints from `exec()` to `execFile()` (no shell interpolation).

---

### 4. Plaintext Password in `check.js` — FIXED (Deleted)
**Severity:** 🔴 Critical

**Fix:** Deleted the file entirely. Monitoring service and dashboard provide the same functionality.

---

### 5. Non-Atomic `containers.updateStatus()` — FIXED
**Severity:** 🟠 High
**File:** `src/db/database.js`

**Fix:** Single atomic UPDATE using `COALESCE(?, field)` to keep existing values when the parameter is null.

---

### 6. SSH Connection Leak on Error in `launchContainer()` — FIXED
**File:** `src/services/containerService.js`

**Fix:** Moved SSH connection creation inside `try` block with `let ssh` declared outside. Added `if (ssh) ssh.close()` in `finally` block.

---

### 7. Stale Cleanup Race Condition — FIXED
**File:** `src/services/monitoringService.js`

**Fix:** Threshold increased to 10 min. In-flight launches tracked in memory to skip stale cleanup.

---

### 8. Scaling Fire-and-Forget — Silent Failures — FIXED
**File:** `src/services/scalingService.js`

**Fix:** `scaleOut()` records `scale_failed` events in the DB on failure. Ghost VM rollback also records events.

---

### 10. `warmPool.replenish()` — No Concurrency Guard — FIXED
**File:** `src/services/warmPoolService.js`

**Fix:** Added in-memory `Set` (`_replenishing`) tracking functions currently being replenished.

---

### 11. Hardcoded GCP VM Root Password Default — FIXED
**File:** `src/services/scalingService.js`

**Fix:** Removed default. Now throws `Error('GCP_VM_ROOT_PASSWORD env var is required')` if not set.

---

### 12. Auto-Scale Cooldown — Wall Clock vs Monotonic — FIXED
**File:** `src/services/scalingService.js`

**Fix:** Changed to `performance.now()` (monotonic, immune to clock adjustments).

---

### 14. Container Launch — No Timeout on Full Launch Sequence — FIXED
**File:** `src/services/containerService.js`

**Fix:** Wrapped `launchContainer()` in `Promise.race()` with configurable timeout (`LAUNCH_TIMEOUT_MS` env var, default 120s).

---

### 20. No Graceful Shutdown in Worker API — FIXED
**File:** `worker-api/index.js`

**Fix:** Added SIGTERM/SIGINT handler with graceful shutdown, 10s drain timeout.

---

### 23. No Health Endpoint on Placement Service — FIXED
**File:** `src/index.js`

**Fix:** `/health` endpoint enhanced with `uptime` and `memory` fields.

---

### 26. Ghost VM Infrastructure Leak in Auto-Scaler — FIXED
**Severity:** 🔴 Critical
**File:** `src/services/scalingService.js` — `scaleOut()`

**Fix:** Compensation Pattern — track `gcpInstance` after Phase 1. If any subsequent phase fails, delete the orphaned VM in the `catch` block.

---

### 27. Split-Brain State Between DB and Worker — FIXED
**Severity:** 🔴 Critical
**Files:** `src/services/monitoringService.js`, `worker-api/index.js`

**Fix:** Reconciliation Loop in `monitoringService.js` that runs after each health check cycle. Compares Worker API `GET /ps` actual state with DB state and reconciles discrepancies.

---

### 28. Stale Gateway Cache After Function Re-Deploy — FIXED
**Severity:** 🔴 Critical

**Fix — 5 layers of defense:**
1. `invalidateGatewayCache(functionName)` invalidates both `ct:` and `fn:` cache keys
2. DELETE route calls `invalidateGatewayCache(func.name)` after purging
3. Deploy route passes `functionName` to `invalidateGatewayCache` on re-deploy
4. Gateway self-heal: `containerStateCheck.js` detects 404/500 and auto-invalidates
5. Execute endpoint validates `function_id` exists before claiming

---

## Summary

| # | Issue | Severity | Status |
|---|---|---|---|
| 1 | Double-claim race condition | 🔴 Critical | ✅ Fixed |
| 2 | Shell injection (env vars) | 🔴 Critical | ✅ Fixed |
| 3 | Shell injection (worker API) | 🔴 Critical | ✅ Fixed |
| 4 | Plaintext password in git | 🔴 Critical | ✅ Fixed |
| 5 | Non-atomic container update | 🟠 High | ✅ Fixed |
| 6 | SSH connection leak | 🟠 High | ✅ Fixed |
| 7 | Stale cleanup race | 🟠 High | ✅ Fixed |
| 8 | Silent scale failures | 🟠 High | ✅ Fixed |
| 10 | Replenish concurrency | 🟠 High | ✅ Fixed |
| 11 | Default VM password | 🟡 Medium | ✅ Fixed |
| 12 | Wall clock cooldown | 🟡 Medium | ✅ Fixed |
| 14 | No launch timeout | 🟡 Medium | ✅ Fixed |
| 20 | Graceful shutdown (worker API) | 🔵 Low | ✅ Fixed |
| 23 | Health endpoint | 🔵 Low | ✅ Fixed |
| 26 | Ghost VM infrastructure leak | 🔴 Critical | ✅ Fixed |
| 27 | Split-brain state (DB vs worker) | 🔴 Critical | ✅ Fixed |
| 28 | Stale gateway cache on re-deploy | 🔴 Critical | ✅ Fixed |