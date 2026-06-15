# Architecture Improvements — Nova Kata

> **Status:** Items 1-6 and 8-10 done, item 7 still planned.
> **Created:** 2026-06-13
> **Updated:** 2026-06-13

---

## 1. Orphan Warm Pool Cleanup (Self-Healing)

### The Problem

When a worker VM disappears (crash, GCP deletion, network partition) without calling `DELETE /workers/:id`, its warm pool entries and container records remain in the database forever. The gateway then tries to route traffic to dead containers.

**Current behavior:**

| Scenario | Warm Pool Cleanup? | Container Cleanup? |
|---|---|---|
| `DELETE /workers/:id` called | ✅ Yes (CASCADE) | ✅ Yes |
| Health check marks worker FAULTY | ✅ Yes | ❌ No |
| Worker VM just disappears | ❌ No | ❌ No |

**Symptom:** Gateway returns 500 with "Failed to claim container" because the placement service tries to SSH to a dead worker.

### The Fix

Add orphan detection to the monitoring cycle (`monitoringService.js`). Every 30s, after health checks:

1. Find warm pool entries where worker is FAULTY or RETIRED → delete them
2. Find containers where worker is FAULTY or RETIRED → mark as `failed`
3. Find entries referencing workers that don't exist at all → clean up

```js
// In runHealthCheckCycle(), after health checks:
function cleanOrphanedEntries() {
    const faultyWorkers = workers.findAll().filter(w => 
        w.status === 'faulty' || w.status === 'retired'
    );
    for (const w of faultyWorkers) {
        warmPool.removeByWorkerId(w.id);
        // Mark containers as failed (not delete — keep for audit)
        db.exec(
            "UPDATE containers SET status = 'failed' WHERE worker_id = ? AND status NOT IN ('stopped','failed')",
            [w.id]
        );
    }
}
```

**Effort**: ~1 hour
**Priority**: Medium — makes the system self-healing without manual cleanup scripts

---

## 2. Shared Container Registry

### The Problem

Each worker runs its own `localhost:5000` registry (started in `provisionService.js`). Images are local to the worker that built them.

**Impact:**
- If Worker A dies → **all function images built on Worker A are lost**
- If a new Worker B joins → it has **no images** and can't run any functions
- You can't add/remove workers without losing images
- Redeploying is the only way to get images on a new worker

**Current flow:**
```
Build on Worker A → image pushed to Worker A's localhost:5000
Worker B can't pull → "image not found" error
```

### Fix Option A: Shared Registry on Placement Service Host

Run a Docker registry on the Nova Kata host (the placement service machine) on port 5000.

```
Build on Worker A → image pushed to <PLACEMENT_HOST>:5000
Worker B pulls from <PLACEMENT_HOST>:5000 → works
```

**Changes needed:**
- Add `REGISTRY_HOST` env var (defaults to placement service's public IP)
- Update `buildService.js`: change `localhost:5000` → `${REGISTRY_HOST}:5000` in image tags and push/pull
- Update `containerService.js`: same change for `nerdctl run --pull missing`
- Run `docker run -d -p 5000:5000 registry:2` on the Nova Kata host
- Workers need to trust the registry: add to `/etc/containerd/config.toml` or use HTTP

**Effort**: ~2-3 hours

### Fix Option B: GCP Artifact Registry

Use GCP Artifact Registry as the shared registry. Works across regions, survives worker replacement.

```
Build on Worker A → push to us-docker.pkg.dev/<project>/nova-repo/nova-fn-name:latest
Worker B pulls from us-docker.pkg.dev/<project>/nova-repo/nova-fn-name:latest
```

**Setup:**
```bash
gcloud artifacts repositories create nova-repo \
    --repository-format=docker \
    --location=us
```

**Changes needed:**
- Add `REGISTRY_HOST` env var (e.g., `us-docker.pkg.dev/cobalt-nomad-370219/nova-repo`)
- Update image tags in `buildService.js` and `containerService.js`
- Workers authenticate via the GCP service account (already configured)
- Add `nerdctl login` step to `provisionService.js`

**Effort**: ~3-4 hours
**Benefit**: Production-grade, works across regions, free tier (0.5 GB storage)

### Recommended Path

| Stage | Registry | Reason |
|---|---|---|
| Development / single VM | `localhost:5000` (current) | Simplest, works fine with 1 worker |
| Multi-worker, same network | Option A: Shared registry on placement host | Easy setup, no GCP dependency |
| Production / multi-region | Option B: GCP Artifact Registry | Survives anything, cross-region, managed |

---

---

## 3. ThreadingHTTPServer for Python Agent ✅ Done

### The Problem

Python's `HTTPServer` handles one request at a time. When 50 concurrent requests hit a Python function, 1 processes and 49 queue in the TCP backlog.

### The Fix

Changed `HTTPServer` → `ThreadingHTTPServer` in `nova-kata/src/services/buildService.js`.

- Built into Python stdlib (since 3.7) — no dependencies
- One thread per request — concurrent handling
- Node.js agent already handles concurrency (async event loop)

---

## 4. Single-Flight Lock for Cold Starts ✅ Done

### The Problem

When 50 requests hit a cold function simultaneously, all 50 call the placement service, creating 100 SSH connections to the worker. The worker crashes under load.

### The Fix

Added `pendingClaims` Map in `nova-kata-gateway/src/middleware/containerStateCheck.js`.

- First request fires the claim, stores the Promise in the Map
- Other 49 requests await the same Promise — zero additional network calls
- `.finally()` cleans up the Map entry regardless of success/failure
- On failure: returns 503 + `Retry-After: 2` (not 500)

---

## 5. Round-Robin Container Pool Routing ✅ Done

### The Problem

Gateway caches one container per function. All traffic goes to one container even when multiple are running.

### The Fix

Changed cache from `{ host_ip, host_port }` to `{ containers: [...], nextIndex: 0 }`.

- DB query fetches ALL running containers (`findAllRunningByFunction`)
- Cache stores the full pool with a rotating index
- Each request picks the next container: A → B → C → A → B → C
- Added `findAllRunningByFunction()` to `nova-kata-gateway/src/db/database.js`

---

---

## 6. Auto-Delete Faulty Workers + PENDING Registration ✅ Done

### The Problems

**Problem A:** When a worker hits 3 consecutive failures, it's marked FAULTY but stays in the DB forever. The health check retries every 30s indefinitely, generating log spam.

**Problem B:** When `initWorker()` SSH fails, the worker is never inserted into the DB. The health check never retries. The worker is orphaned — provisioned but invisible.

### The Fix

**A — Auto-delete** (in `nova-kata/src/services/workerService.js`):

When `consecutive_failures >= MAX_CONSECUTIVE_FAILURES` (default 3):
- Delete warm pool entries
- Delete containers
- Delete the worker row
- No more infinite FAULTY retries

**B — PENDING registration** (in `nova-kata/src/services/workerService.js`):

When `initWorker()` SSH connection fails:
- Insert worker into DB with `status: 'pending'`
- Health check cycle retries validation every 30s
- When SSH succeeds: run full validation (nerdctl, kata) → mark `healthy`
- When 3 failures accumulate: auto-delete (via Fix A)

### Flow

```
New worker → SSH fails → PENDING (in DB)
  ↓ 30s
Health check → SSH fails → failures=1
  ↓ 30s
Health check → SSH succeeds → full validation → HEALTHY ✅
```

Or if truly dead:
```
PENDING → fail → fail → fail → AUTO-DELETED ✅
```

---

## 7. Load-Aware Pool Scaling (Scale Up + Down)

### The Problem

Even with round-robin pool routing (item 5), the gateway only claims **1 container** on a cold start. All subsequent requests route to that 1 container. The warm pool may have 5 containers ready, but the gateway never claims them.

**Current flow:**
```
50 concurrent requests → claim 1 container → all 50 go to Container A
```

The single-flight lock (item 4) deduplicates the claim, but it also means only 1 container is ever claimed for a burst. The round-robin only helps when multiple containers are already in the cache.

### Architecture

```
                         ┌──────────────────┐
  Request → gateway →   │ containerState    │
                         │ Check middleware  │
                         └──────┬───────────┘
                                │
                    ┌───────────┼───────────┐
                    │           │           │
              ┌─────▼────┐ ┌────▼────┐ ┌────▼────┐
              │ Request  │ │  Pool   │ │ Scale   │
              │ Tracker  │ │ Router  │ │ Manager │
              │ (rate)   │ │ (rr)    │ │ (up/dn) │
              └──────────┘ └─────────┘ └─────────┘
```

### Component 1: Request Tracker (`nova-kata-gateway/src/utils/requestTracker.js`)

Sliding window counter — tracks requests per second per function.

```js
class RequestTracker {
    constructor(windowMs = 5000)  // 5-second sliding window

    recordRequest(functionId)     // Called on every request — pushes Date.now()
    getRate(functionId)           // Prunes old entries, returns count / windowSec
}
```

- Keeps an array of timestamps per function
- On `recordRequest()`: push `Date.now()`
- On `getRate()`: remove entries older than 5s, return `count / 5`
- Simple, accurate, no EWMA complexity

### Component 2: Scale Manager (in `containerStateCheck.js`)

Runs **after** each request is routed. Two checks:

**Scale Up — "Do we need more containers?"**

```js
rate = tracker.getRate(functionId)                     // e.g., 25 req/s
desired = Math.ceil(rate / CONCURRENCY_PER_CONTAINER)  // e.g., ceil(25/10) = 3
current = pool.containers.length                       // e.g., 1

if (current < desired && current < maxContainers) {
    if (now - pool.lastScaleUp > SCALE_UP_COOLDOWN_MS) {  // 5s cooldown
        claimAdditionalContainer(functionData.id)          // async, non-blocking
            .then(newContainer => {
                pool.containers.push(newContainer);
                pool.lastScaleUp = Date.now();
                cache.set(cacheKey, pool);
            });
    }
}
```

**Scale Down — "Do we have too many containers?"**

```js
rate = tracker.getRate(functionId)
desired = Math.max(minContainers, Math.ceil(rate / CONCURRENCY_PER_CONTAINER))
current = pool.containers.length

if (current > desired) {
    if (now - pool.lastScaleDown > SCALE_DOWN_COOLDOWN_MS) {  // 30s cooldown
        const removed = pool.containers.pop();                 // remove least-recently-used
        pool.lastScaleDown = Date.now();
        cache.set(cacheKey, pool);
        // Return container to warm pool
        placementClient.post('/unclaim', { container_id: removed.container_id });
    }
}
```

### Component 3: Unclaim Endpoint (`POST /unclaim` on Nova Kata)

New endpoint to return a claimed container back to the warm pool:

```js
// In nova-kata/src/routes/warm-pool.js (or execute.js)
router.post('/unclaim', async (req, res) => {
    const { container_id } = req.body;
    // 1. Pause the container (nerdctl pause) via SSH to worker
    // 2. Update warm_pool: status = 'warm', claimed_at = null
    // 3. Update containers: status = 'paused'
    return res.json({ success: true });
});
```

### Pool Cache Structure

```js
ct:functionName → {
    containers: [
        { vmTarget, container_id, host_ip, host_port },
        { vmTarget, container_id, host_ip, host_port },
    ],
    nextIndex: 0,
    lastScaleUp: 1718280000000,     // timestamp
    lastScaleDown: 1718280000000,   // timestamp
    scaleUpPending: false,           // prevent duplicate async claims
}
```

### Configuration

```env
CONCURRENCY_PER_CONTAINER=10    # req/s each container handles comfortably
SCALE_UP_COOLDOWN_MS=5000       # 5s between scale-ups (don't spam)
SCALE_DOWN_COOLDOWN_MS=30000    # 30s before scale-down (avoid flapping)
MIN_CONTAINERS=1                # never go below this
# MAX_CONTAINERS comes from function.max_containers in DB
```

### Example Scenarios

**Burst of 50 requests:**
```
t=0s   50 requests arrive → pool empty → claim 1 container → pool: [A]
t=0.1s requests routed to A, tracker rate = 50/s
t=0.2s scale-up check: desired=5, current=1 → claim B (async)
t=0.5s B claimed → pool: [A, B], round-robin distributes
t=1s   scale-up: desired=5, current=2 → claim C
t=1.5s C claimed → pool: [A, B, C]
...continues until pool reaches 5 or max_containers
```

**Traffic drops to 1 req/s:**
```
t=30s  rate drops to 1/s, current=5
t=60s  scale-down cooldown expired, desired=1 → unclaim E → pool: [A,B,C,D]
t=90s  scale-down: unclaim D → pool: [A,B,C]
...continues until pool reaches 1
```

**Steady 10 req/s:**
```
Pool stabilizes at 1-2 containers. No scale-up or scale-down.
```

### Files to Create/Modify

| File | Change |
|---|---|
| `nova-kata-gateway/src/utils/requestTracker.js` | New — sliding window request rate tracker |
| `nova-kata-gateway/src/middleware/containerStateCheck.js` | Add scale-up/down logic after routing |
| `nova-kata/src/routes/warm-pool.js` (or execute.js) | Add `POST /unclaim` endpoint |

**Effort**: ~2-3 hours

---

---

## 8. Worker API — HTTP Agent on Worker VMs ✅ Done

### The Problem

Every container operation (pause, unpause, health check) required an SSH connection from the Placement Service to the worker VM. SSH handshake + crypto + bash spawn adds ~130-260ms overhead per operation.

### The Fix

Deployed a lightweight Express HTTP server (`nova-kata/worker-api/`) on each worker VM that executes nerdctl commands locally.

**Architecture:**
```
Placement Service → HTTP (keep-alive) → Worker API → nerdctl → containerd
                   ~60-90ms overhead (vs ~130-260ms with SSH)
```

**Implemented endpoints:**
- `POST /pause` — pause a container
- `POST /unpause` — unpause a container
- `GET /health` — containerd + uptime status
- `GET /stats` — container counts + nerdctl version

**Key features:**
- Shared API key auth (`X-Worker-Key` header)
- SSH fallback — if Worker API is unreachable, falls back to SSH (zero-downtime migration)
- systemd service for auto-restart
- Installed during provisioning (Step 13)
- Persistent HTTP client with keep-alive (no handshake per request)

**Latency saved:** ~70-170ms per pause/unpause operation

**Files:**
- `nova-kata/worker-api/index.js` — Worker API server
- `nova-kata/worker-api/package.json` — dependencies
- `nova-kata/worker-api/nova-worker-api.service` — systemd unit
- `nova-kata/src/services/containerService.js` — Worker API client + SSH fallback

---

## 9. Nginx Removal — Direct Port Mapping ✅ Done

### The Problem

Nginx was used as a reverse proxy on each worker VM to route traffic from host port to container IP. This required:
- Nginx install during provisioning
- Config file write + `nginx -s reload` per container launch
- Config cleanup + reload per container stop
- Risk of reload thrashing under rapid scale-out

### The Fix

Replaced nginx with nerdctl's built-in `-p` port mapping (iptables/NAT):

```bash
# Before: no port mapping, nginx bridges the gap
nerdctl run -d --name nova-xxx <image>
# + write /etc/nginx/conf.d/nova-xxx.conf
# + nginx -s reload

# After: nerdctl handles port forwarding directly
nerdctl run -d -p 9000:8080 --name nova-xxx <image>
# Done. Gateway hits worker_ip:9000 directly.
```

**Benefits:**
- Simpler provisioning (no nginx install step)
- No config file management
- No reload thrashing risk
- One less network hop (nginx process bypassed)
- Auto-cleanup on `nerdctl rm` (iptables rules removed)

**Files:**
- `nova-kata/src/services/containerService.js` — `-p` flag added, nginx code removed
- `nova-kata/src/services/provisionService.js` — Step 11 (nginx) removed

---

## 10. Direct Node.js Binary — No NodeSource ✅ Done

### The Problem

Installing Node.js via NodeSource (`curl | bash - && apt-get install`) caused:
- GPG key verification failures (`Couldn't create temporary file /tmp/apt.conf.*`)
- Broken apt repos blocking subsequent `apt-get update`
- PATH issues in non-login shells (`npm: command not found`)

### The Fix

Download Node.js binary tarball directly from nodejs.org:

```bash
wget -q https://nodejs.org/dist/v20.11.1/node-v20.11.1-linux-x64.tar.xz -O /tmp/node.tar.xz
tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
# Result: /usr/local/bin/node and /usr/local/bin/npm
```

**Benefits:**
- No apt repo, no GPG issues
- Deterministic version (exact tarball)
- Works with systemd directly (`/usr/local/bin/node`)
- No PATH tricks needed

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
| 7. Load-aware pool scaling | High (adaptive scaling) | ~2-3 hours | Planned |
| 8. Worker API (HTTP agent on workers) | High (latency: -70-170ms/op) | ~3 hours | ✅ Done |
| 9. Nginx removal (direct port mapping) | Medium (simpler, faster) | ~1 hour | ✅ Done |
| 10. Direct Node.js binary (no NodeSource) | Medium (reliable provisioning) | ~30 min | ✅ Done |
