# Nova Serverless Platform — Thesis Codebase Context

## 1. Project Identity

Nova is a serverless function platform built on Kata Containers and QEMU. It executes user-submitted functions inside lightweight virtual machines, using a warm pool of cgroup-frozen containers to reduce cold-start latency from ~1625 ms to sub-3 ms.

Three deployable components form the system:

| Component | Role | Port | Stack |
|---|---|---|---|
| `nova-kata` | Control plane (placement, scheduling, build, scaling) | 3002 | Node.js, CommonJS |
| `nova-kata-gateway` | Data plane (request routing, proxying) | 8081 (public), 3003 (internal) | Node.js, ESM |
| `nova-dashboard` | Web UI (function management, monitoring) | 3000 | Next.js, TypeScript |

**Thesis claim**: a warm pool of cgroup-frozen Kata Containers reduces cold-start from ~1625 ms to sub-3 ms.

---

## 2. Architectural Decisions

Eight decisions shaped the system. Each is stated with its rationale — what was chosen, what was rejected, and why.

### 2.1 QEMU over Firecracker

QEMU provides the VM monitor for Kata Containers. Firecracker was rejected because it lacks the `vm_cache` and `machine_accelerators` tuning knobs needed for fast VM reuse. Each QEMU VM consumes ~128 MB of overhead and boots in ~1295 ms. Kata configuration sets `vm_cache=5` to keep up to 5 cached VM processes for faster subsequent launches.

### 2.2 Kata Containers over raw KVM

Kata Containers provide OCI compatibility via the `io.containerd.kata.v2` runtime. This means `nerdctl` (and Docker CLI) can manage Kata VMs identically to regular containers. Raw KVM was rejected because it would require a custom image loader, networking stack, and process supervisor — all of which Kata already provides.

### 2.3 Agentless SSH (`ssh2`) + Worker API fallback

No agent process runs inside the VM by default. Orchestration commands (`nerdctl run`, `nerdctl pause`, `nerdctl unpause`) are executed over SSH from the placement service, with the Worker API (port 3005) as an HTTP fallback. This avoids the ~330 ms agent initialization time during cold start. SSH handshakes cost 50–150 ms per connection.

### 2.4 Node.js Express 5.x gateway

The gateway is I/O-bound (proxying HTTP requests). Node.js's event loop handles thousands of concurrent connections in a single thread. Express 5.x provides the middleware pipeline. No thread-based runtime (Go, Rust) was chosen because the bottleneck is VM boot time, not gateway throughput.

### 2.5 PostgreSQL 16 over SQLite WAL

SQLite WAL was the original store. PostgreSQL 16 was chosen for three reasons:
- `SELECT ... FOR UPDATE SKIP LOCKED` — concurrent warm-pool claims without contention
- Connection pooling (`pg` driver, pool max 20) — higher concurrency than SQLite's single-writer model
- `TIMESTAMPTZ` columns — proper timezone handling

### 2.6 Data plane / control plane separation

The gateway (`nova-kata-gateway`, port 8081) handles all function invocation traffic. The placement service (`nova-kata`, port 3002) handles container lifecycle, builds, and scaling. They communicate via HTTP on the internal port (3003). This separation means gateway restarts do not disrupt in-flight requests, and placement restarts do not affect the proxy pipeline.

### 2.7 `node-cache` + `ioredis` dual cache

Function metadata and container state are cached in-process via `node-cache` (always active). If `REDIS_URL` is set, the same keys are also stored in Redis, enabling shared state across multiple gateway instances. Without Redis, each gateway holds an independent cache.

### 2.8 GCP `@google-cloud/compute` v6.9.1

Worker VMs are provisioned on Google Compute Engine. The `n2-standard-2` machine type provides nested virtualization (required for Kata). The default region is `us` (configurable via `GCP_DEFAULT_REGION`). A startup script installs containerd, nerdctl, and Kata on first boot.

---

## 3. System Components

### 3.1 Warm Pool

The warm pool is the core contribution of this thesis. It maintains a set of pre-launched, cgroup-frozen Kata Containers that can be claimed in sub-3 ms instead of waiting ~1625 ms for a cold start.

**Source files**: `nova-kata/src/services/warmPoolService.js`, `nova-kata/src/services/containerService.js`, `nova-kata/src/db/database.js`

**Exported functions** (`warmPoolService.js`):
- `claimWarmContainer(functionId)` — atomically claim a paused container from the pool
- `replenishPool(functionId)` — create new paused containers to maintain `WARM_POOL_MIN`
- `getPoolStats()` — return current pool size and status counts

**Claim algorithm** (inside `claimWarmContainer`):
1. `SELECT ... FOR UPDATE SKIP LOCKED` — find a `warm`-status row, skipping rows locked by concurrent transactions
2. `UPDATE status = 'claimed', claimed_at = NOW()` — atomically mark the row
3. `nerdctl unpause` — thaw the cgroup (~1–2 ms)
4. Return the container to the caller

**Pause/unpause mechanism**:
- `nerdctl pause` writes `cgroup.freeze` to the container's cgroup — the VM stays in memory but the CPU is halted
- `nerdctl unpause` writes `cgroup.thaw` — the VM resumes execution in ~1–2 ms
- No process restart, no VM reboot, no agent re-initialization

**State machine**:

| From | Event | To | Action |
|---|---|---|---|
| — | `launchContainer` | `creating` | `nerdctl run` |
| `creating` | VM ready | `running` | register in DB |
| `running` | `pauseContainer` | `paused` | `nerdctl pause` (cgroup freeze) |
| `paused` | `claimWarmContainer` | `claimed` | `nerdctl unpause` (cgroup thaw) |
| `claimed` | unpause complete | `running` | serve requests |
| `running` | `stopContainer` | `stopped` | `nerdctl stop` |
| any | error | `failed` | log + increment failure count |

**Pool state machine** (from `warm_pool` table):

| From | Event | To |
|---|---|---|
| — | container paused | `warm` |
| `warm` | `claimWarmContainer` | `claimed` |
| `claimed` | container released | `warm` (re-paused) or removed |

**Configuration**:

| Variable | Default | Description |
|---|---|---|
| `WARM_POOL_MIN` | 2 | Minimum paused containers per function |
| `WARM_POOL_MAX` | 10 | Upper bound on pool size |
| `WARM_POOL_REPLENISH_INTERVAL_MS` | 15000 | How often `replenishPool` runs |

**RAM tradeoff**: each paused Kata VM retains its memory allocation. At 256 MB per VM, `WARM_POOL_MAX=10` reserves up to 2560 MB across all functions. At 128 MB per VM (minimal), the same pool uses 1280 MB.

---

### 3.2 Gateway Middleware Pipeline

The gateway processes every function invocation request through a 14-step pipeline. Steps 1–8 apply to all requests; steps 9–14 apply only to function invocation paths.

**Source file**: `nova-kata-gateway/src/index.js`

| Step | Middleware | Implementation | Effect |
|---|---|---|---|
| 1 | `injectRequestId` | Inline | Assigns `req.requestId` (UUIDv4), `req.startTime` (`performance.now()`), child logger |
| 2 | `wrapResponse` | Inline | Wraps `res.json` to auto-inject `request_id` into error responses |
| 3 | Request timeout | Inline | `req.setTimeout(REQUEST_TIMEOUT_MS)` → 504 if exceeded |
| 4 | `ipLimiter` | `express-rate-limit` | 100 req/s per IP, `RateLimit-*` standard headers |
| 5 | Compression | `compression` | Threshold 1024 B, skipped for proxied responses (`req.vmTarget`) |
| 6 | CORS | Inline | Origin reflection, `Access-Control-Max-Age: 86400` (24 h preflight cache) |
| 7 | Health check | Route `GET /health` | Returns `{ status, uptime, cache }` — placed before `parseHost` |
| 8 | Browser filter | Inline | 204 for `/favicon.ico`, `/.well-known/*`, `/robots.txt`, `apple-touch-icon` |
| 9 | `parseHost` | `./middleware/parseHost.js` | Extracts function name from subdomain or path → `req.functionName` |
| 10 | `functionLimiter` | `express-rate-limit` | 50 req/s per function name |
| 11 | `existenceCheck` | `./middleware/existenceCheck.js` | Cache lookup `fn:<name>`, then DB, then 404 |
| 12 | `authCheck` | `./middleware/authCheck.js` | Validates `X-Api-Key` header → 401 if invalid |
| 13 | `containerStateCheck` | `./middleware/containerStateCheck.js` | Cache lookup `ct:<name>`, then DB, then `POST /execute` to placement, then round-robin |
| 14 | `forwardRequest` | `./proxy/forwardRequest.js` | `http-proxy-middleware` to `req.vmTarget` |

**Internal server** (port 3003): separate Express app with `injectRequestId`, `wrapResponse`, `GET /metrics` (Prometheus), and `/internal` routes for cache invalidation from the placement service.

**Graceful shutdown**: on `SIGTERM`/`SIGINT`, the gateway stops accepting new connections, waits up to 10 s (`DRAIN_TIMEOUT_MS`) for in-flight connections to drain, then exits.

---

### 3.3 Dual-Layer Caching

The gateway caches function metadata and container state in two layers to minimize per-request database queries.

**Source file**: `nova-kata-gateway/src/cache/cache.js`

| Layer | Technology | Always active? | Keys | TTL |
|---|---|---|---|---|
| L1 | `node-cache` (in-process) | Yes | `fn:<name>`, `ct:<name>` | `fn`: 3600 s, `ct`: 300 s |
| L2 | `ioredis` (Redis) | Only if `REDIS_URL` set | Same keys | Same TTLs |

**Performance**:
- Cache hit: ~1–2 ms routing overhead (no DB query)
- Cache miss: ~5–8 ms (PostgreSQL query + cache population)

**Pre-warming on startup** (in `nova-kata-gateway/src/index.js`):
1. Load all functions via `functionsDb.findAll()` → set `fn:<name>` for each
2. Load all running containers per function via `containersDb.findAllRunningByFunction()` → set `ct:<name>` with round-robin index

This ensures first requests after a gateway restart are cache hits.

**Cache invalidation**: the placement service calls `POST /internal/invalidate-cache` on the gateway's internal port (3003) after container state changes (launch, pause, claim, stop).

---

### 3.4 Multi-Runtime Build Service

The build service generates a Dockerfile per runtime, uploads user code + agent to the worker, builds an OCI image via `nerdctl`, and pushes it to a shared registry.

**Source file**: `nova-kata/src/services/buildService.js`

**Exported functions**:
- `buildFunctionImage(worker, opts, onLog)` — build and push a function image
- `deleteFunctionResources(worker, funcName, containerNames)` — stop containers, remove image, clean build dir

**Supported runtimes** (8):

| Runtime | Base image | Dependency install | Entrypoint |
|---|---|---|---|
| `python` | `python:3.11-slim` | `pip install --no-cache-dir -r requirements.txt` | `["python3", "/nova_agent.py"]` |
| `nodejs` | `node:20-slim` | `npm install --omit=dev` | `["node", "/nova_agent.js"]` |
| `php` | `php:8.2-cli-slim` | (none) | `["php", "-S", "0.0.0.0:8080", "/function/<entry>"]` |
| `ruby` | `ruby:3.2-slim` | `bundle install` | `["ruby", "/function/<entry>"]` |
| `golang` | `golang:1.21-alpine` | `go build` | `["./main"]` |
| `java` | `openjdk:17-slim` | (none) | `["java", "-jar", "/function/<entry>"]` |
| `dotnet` | `mcr.microsoft.com/dotnet/sdk:8.0` | `dotnet publish` | `["dotnet", "<entry>"]` |

**Nova HTTP agent** (embedded in `buildService.js`):
- `NOVA_AGENT_PY` — Python HTTP server wrapping `handler(event)`, supports all HTTP methods
- `NOVA_AGENT_JS` — Node.js HTTP server wrapping `handler(event)`, supports all HTTP methods
- Only `python` and `nodejs` runtimes use the Nova agent; other runtimes use their native HTTP server or direct execution

**Build flow** (`buildFunctionImage`):
1. Check Worker API health → set `useWorkerApi` flag
2. Open SSH connection (always needed for build streaming)
3. Create build directory `/opt/nova/build/<name>`
4. Upload user files via `writeRemote` (Worker API `/write-file` or SSH)
5. Write Nova agent file (`nova_agent.py` or `nova_agent.js`) for python/nodejs
6. Ensure dependency file exists (write empty placeholder if missing)
7. Write generated Dockerfile
8. `nerdctl build --insecure-registry --no-cache -t <tag> <buildDir>`
9. Verify image exists via `nerdctl images`
10. `nerdctl push --insecure-registry <tag>` to shared registry

**Image tag format**: `<REGISTRY_HOST>/nova-fn-<name>:latest`

---

### 3.5 SSH-Based Agentless Orchestration

The placement service executes commands on worker VMs via SSH, with the Worker API as an HTTP fallback. No persistent agent runs inside the VM.

**Source file**: `nova-kata/src/services/workerService.js`

**Exported functions**:
- `execOnWorker(worker, command, timeout)` — execute a command on a worker
- `writeRemoteFile(ssh, remotePath, content, onLog)` — write a file via base64-encoded chunks over SSH

**SSH configuration**:

| Variable | Default | Description |
|---|---|---|
| `SSH_CONNECT_TIMEOUT` | 10000 ms | Connection establishment timeout |
| `SSH_EXEC_TIMEOUT` | 30000 ms | Command execution timeout |

**Base64 file transfer** (`writeRemoteFile` in `buildService.js`):
1. Encode file content as base64
2. Split into 2000-character chunks
3. Write first chunk: `echo '<chunk>' > /tmp/_nova_b64`
4. Append remaining chunks: `echo '<chunk>' >> /tmp/_nova_b64`
5. Decode: `base64 -d /tmp/_nova_b64 > <remotePath> && rm /tmp/_nova_b64`

This avoids heredoc quoting issues and shell special character corruption.

**Worker API fallback** (port 3005):
- Auth: `X-Worker-Key` header validated against `WORKER_API_KEY`
- Endpoints used by build service: `/health`, `/exec`, `/write-file`
- `writeRemote` tries Worker API first, falls back to SSH on failure
- `remoteRun` tries Worker API `/exec` first, falls back to SSH

**Limitation**: no SSH connection pooling — a new TCP connection and handshake (50–150 ms) is established per command.

---

### 3.6 Dynamic Nginx Ingress

After a container launches and CNI allocates an IP, the placement service rewrites the worker's Nginx configuration to route traffic to the container.

**Source file**: `nova-kata/src/services/containerService.js` (`configureNginx`)

**Flow**:
1. `nerdctl inspect <container>` → extract container IP from CNI allocation
2. Generate `nginx.conf` with `upstream` blocks per function, mapping to container IPs
3. Write config to worker via SSH/Worker API
4. `nginx -s reload` to apply

**Known race condition**: under high container churn (rapid launch/stop cycles), Nginx config generation may reference stale IPs if a container is removed between inspect and reload. This is acknowledged and documented as future work.

---

### 3.7 PostgreSQL Database

**Source files**: `nova-kata/src/db/database.js`, `nova-kata/src/db/schema.sql`

**Connection**: `pg` driver, pool max 20, `DATABASE_URL` environment variable.

**Schema** (8 tables):

#### `workers`

| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `ip` | TEXT | NOT NULL |
| `username` | TEXT | NOT NULL |
| `password` | TEXT | NOT NULL |
| `ssh_port` | INTEGER | NOT NULL DEFAULT 22 |
| `status` | TEXT | NOT NULL DEFAULT 'unknown' |
| `created_at` | TIMESTAMPTZ | DEFAULT CURRENT_TIMESTAMP |
| `updated_at` | TIMESTAMPTZ | DEFAULT CURRENT_TIMESTAMP |
| `last_seen_at` | TIMESTAMPTZ | nullable |
| `consecutive_failures` | INTEGER | DEFAULT 0 |
| `gcp_instance_name` | TEXT | nullable |
| `gcp_zone` | TEXT | nullable |

#### `functions`

| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `name` | TEXT | NOT NULL |
| `image` | TEXT | NOT NULL |
| `region` | TEXT | NOT NULL |
| `agent_cmd` | TEXT | nullable |
| `agent_port` | INTEGER | nullable |
| `env_vars` | TEXT | nullable |
| `memory_limit` | INTEGER | DEFAULT 512 |
| `cpu_limit` | REAL | DEFAULT 1.0 |
| `storage_limit` | INTEGER | DEFAULT 512 |
| `max_containers` | INTEGER | DEFAULT 10 |
| `warm_count` | INTEGER | DEFAULT 1 |
| `status` | TEXT | NOT NULL DEFAULT 'active' |
| `auth_policy` | TEXT | NOT NULL DEFAULT 'public' |
| `created_at` | TIMESTAMPTZ | DEFAULT CURRENT_TIMESTAMP |
| `updated_at` | TIMESTAMPTZ | DEFAULT CURRENT_TIMESTAMP |

#### `api_keys`

| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `key` | TEXT | NOT NULL UNIQUE |
| `function_id` | TEXT | NOT NULL, FK → functions(id) ON DELETE CASCADE |
| `status` | TEXT | NOT NULL DEFAULT 'active' |
| `created_at` | TIMESTAMPTZ | DEFAULT CURRENT_TIMESTAMP |
| `updated_at` | TIMESTAMPTZ | DEFAULT CURRENT_TIMESTAMP |

#### `containers`

| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `worker_id` | TEXT | NOT NULL, FK → workers(id) ON DELETE CASCADE |
| `container_name` | TEXT | NOT NULL |
| `image` | TEXT | NOT NULL |
| `runtime` | TEXT | NOT NULL |
| `container_ip` | TEXT | nullable |
| `host_port` | INTEGER | nullable |
| `agent_port` | INTEGER | nullable |
| `status` | TEXT | NOT NULL DEFAULT 'creating' |
| `function_id` | TEXT | FK → functions(id) ON DELETE SET NULL |
| `metadata` | TEXT | nullable |
| `started_at` | TIMESTAMPTZ | DEFAULT CURRENT_TIMESTAMP |
| `stopped_at` | TIMESTAMPTZ | nullable |

#### `warm_pool`

| Column | Type | Constraints |
|---|---|---|
| `id` | SERIAL | PRIMARY KEY |
| `container_id` | TEXT | NOT NULL, FK → containers(id) ON DELETE CASCADE |
| `worker_id` | TEXT | NOT NULL, FK → workers(id) ON DELETE CASCADE |
| `function_id` | TEXT | FK → functions(id) ON DELETE SET NULL |
| `status` | TEXT | NOT NULL DEFAULT 'warm' |
| `created_at` | TIMESTAMPTZ | DEFAULT CURRENT_TIMESTAMP |
| `claimed_at` | TIMESTAMPTZ | nullable |

#### `worker_events`

| Column | Type | Constraints |
|---|---|---|
| `id` | SERIAL | PRIMARY KEY |
| `worker_id` | TEXT | NOT NULL, FK → workers(id) ON DELETE CASCADE |
| `event_type` | TEXT | NOT NULL |
| `message` | TEXT | nullable |
| `created_at` | TIMESTAMPTZ | DEFAULT CURRENT_TIMESTAMP |

#### `invocations`

| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `function_id` | TEXT | NOT NULL, FK → functions(id) ON DELETE CASCADE |
| `container_id` | TEXT | nullable |
| `status_code` | INTEGER | nullable |
| `latency_ms` | INTEGER | nullable |
| `request_method` | TEXT | nullable |
| `request_path` | TEXT | nullable |
| `created_at` | TIMESTAMPTZ | DEFAULT CURRENT_TIMESTAMP |

#### `pg_migrations`

| Column | Type | Constraints |
|---|---|---|
| `name` | TEXT | PRIMARY KEY |
| `applied_at` | TIMESTAMPTZ | DEFAULT CURRENT_TIMESTAMP |

**Key transaction**: `claimWarmContainer` uses `SELECT ... FOR UPDATE SKIP LOCKED` on `warm_pool` to atomically claim a row without blocking concurrent claims.

---

### 3.8 Cold Start Benchmarks

Cold-start latency is the time from request arrival at the gateway to the first byte of the function response when no warm container exists.

| Phase | Duration | Description |
|---|---|---|
| QEMU VM boot | ~1295 ms | Kata launches a new QEMU process |
| Agent init | ~330 ms | Containerd shim + Kata agent handshake |
| **Total cold start** | **~1625 ms** | Sum of VM boot + agent init |

Warm-start latency (cgroup unpause):

| Phase | Duration | Description |
|---|---|---|
| cgroup thaw | ~1–2 ms | `nerdctl unpause` writes `cgroup.thaw` |
| Gateway routing | ~1 ms | Cache hit + proxy setup |
| **Total warm start** | **sub-3 ms** | Routing overhead only |

**Measurement**: `performance.now()` timestamps captured in `injectRequestId` (start) and `forwardRequest` (end). The difference is logged as `latency_ms` and stored in the `invocations` table.

---

### 3.9 GCP Autoscaling

**Source file**: `nova-kata/src/services/scalingService.js`

**Exported functions**:
- `scaleOut(region)` — provision a new GCP worker VM
- `getMetrics()` — return cluster utilization metrics

**Scale-out trigger**: cluster utilization exceeds `SCALE_OUT_THRESHOLD` (default 0.75 = 75%). A value of 1.0 disables auto-scaling.

**Configuration**:

| Variable | Default | Description |
|---|---|---|
| `SCALE_OUT_THRESHOLD` | 0.75 | Utilization fraction to trigger scale-out |
| `MAX_WORKERS` | 1 | Maximum number of worker VMs |
| `SCALE_OUT_COOLDOWN_MIN` | 10 | Minimum minutes between scale-out events |
| `GCP_MACHINE_TYPE` | n2-standard-2 | GCP instance type (nested virt required) |
| `GCP_DISK_SIZE_GB` | 100 | Boot disk size |
| `GCP_DEFAULT_REGION` | us | Default GCP region |
| `GCP_VM_ROOT_PASSWORD` | (required) | Root password for new VMs |
| `GCP_VM_SSH_PORT` | 22 | SSH port on provisioned workers |

**VM lifecycle** (`scaleOut`):
1. Generate instance name: `nova-worker-<uuid4-prefix>`
2. `gcpService.createInstance({ region, instanceName, rootPassword })` → `{ ip, zone }`
3. Wait for SSH availability
4. Run startup script: install containerd, nerdctl, Kata, configure SSH
5. Validate worker health
6. Register worker in `workers` table with GCP metadata (`gcp_instance_name`, `gcp_zone`)

**Scale-in**: `deleteInstance({ instanceName, zone })` removes the VM and deregisters the worker.

---

### 3.10 Worker API (Guest Agent)

The Worker API is an Express server running inside each worker VM. It provides an HTTP interface for container operations as an alternative to SSH.

**Source file**: `nova-kata/worker-api/index.js`

**Port**: 3005 (configurable via `WORKER_API_PORT`)

**Authentication**: `X-Worker-Key` header validated against `WORKER_API_KEY`

**Endpoints** (12):

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check (containerd status) |
| GET | `/ps` | List containers |
| GET | `/stats` | System resource stats |
| GET | `/ksm-stats` | Kernel samepage merging stats |
| POST | `/pause` | Pause a container (`nerdctl pause`) |
| POST | `/unpause` | Unpause a container (`nerdctl unpause`) |
| POST | `/stop` | Stop a container (`nerdctl stop`) |
| GET | `/container-stats` | Per-container resource stats |
| POST | `/build` | Build an OCI image |
| POST | `/exec` | Execute a shell command |
| POST | `/write-file` | Write a file (base64 payload) |
| POST | `/launch` | Launch a container (base64 script) |

**Implementation details**:
- Uses `execFile` for container operations (no shell interpolation)
- Uses `exec` for general commands
- `/write-file` accepts `{ path, content_base64 }` — decodes base64 before writing
- `/launch` accepts `{ script_base64 }` — decodes and executes

---

## 4. Data Flows

### 4.1 Cold Start Request

When no warm container exists for a function, the system must launch a new Kata VM:

1. Client → Gateway :8081 (`injectRequestId` assigns UUIDv4 + `performance.now()`)
2. `parseHost` extracts function name from subdomain/path
3. `existenceCheck`: cache miss → DB query → cache `fn:<name>`
4. `containerStateCheck`: cache miss → DB query → no containers found
5. Gateway → Placement :3002 `POST /execute`
6. Placement: `warmPoolService.claimWarmContainer()` — no paused containers available
7. Placement: `schedulerService.pickWorker()` — select healthy worker
8. Placement: `containerService.launchContainer()` — SSH/WorkerAPI `nerdctl run`
9. Wait ~1625 ms (1295 ms QEMU boot + 330 ms agent init)
10. Placement: `containerService.configureNginx()` — update ingress
11. Placement → Gateway: cache invalidation on internal port
12. Gateway: `forwardRequest` proxy to container
13. Container executes function, response proxied to client

### 4.2 Warm Start Request

When a warm container exists in the pool:

1. Client → Gateway :8081 (`injectRequestId`)
2. `parseHost` extracts function name (~0.1 ms)
3. `existenceCheck`: cache hit `fn:<name>` (~0.5 ms)
4. `containerStateCheck`: cache hit `ct:<name>` round-robin select (~0.5 ms)
5. `forwardRequest` proxy to container (~1 ms)
6. Container executes function, response proxied to client
7. **Total routing overhead: ~3 ms**

### 4.3 Warm Pool Claim Flow

When `containerStateCheck` finds no running containers but the warm pool has paused entries:

1. Gateway → Placement :3002 `POST /execute`
2. Placement: `warmPoolService.claimWarmContainer()`
3. `SELECT ... FROM warm_pool WHERE function_id = $1 AND status = 'warm' FOR UPDATE SKIP LOCKED`
4. `UPDATE warm_pool SET status = 'claimed', claimed_at = NOW() WHERE id = $1`
5. `nerdctl unpause <container>` (~1–2 ms cgroup thaw)
6. `UPDATE containers SET status = 'running' WHERE id = $1`
7. Placement → Gateway: cache invalidation
8. Gateway: `forwardRequest` proxy to container

---

## 5. State Machines

### 5.1 Container States

| State | Description |
|---|---|
| `creating` | `nerdctl run` in progress, VM booting |
| `running` | Container active, serving requests |
| `paused` | Container frozen via cgroup, in warm pool |
| `stopped` | Container terminated |
| `failed` | Container errored, not recoverable |

### 5.2 Warm Pool States

| State | Description |
|---|---|
| `warm` | Paused and available for claim |
| `claimed` | Claimed and being unpaused |
| `released` | Returned to pool (re-pausing) |

### 5.3 Worker States

| State | Description |
|---|---|
| `healthy` | Passing health checks |
| `unhealthy` | Failing health checks (`consecutive_failures >= MAX_CONSECUTIVE_FAILURES`) |
| `retired` | Removed from scheduling |

### 5.4 Function States

| State | Description |
|---|---|
| `active` | Has running or paused containers |
| `idle` | Has paused containers only |
| `deploying` | Image build in progress |

---

## 6. Configuration Values

### 6.1 Ports

| Variable | Default | Component |
|---|---|---|
| `PORT` | 3002 | nova-kata (placement) |
| `GATEWAY_PORT` | 8081 | nova-kata-gateway (public) |
| `INTERNAL_PORT` | 3003 | nova-kata-gateway (internal) |
| `WORKER_API_PORT` | 3005 | Worker API (guest) |

### 6.2 Database

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | (required) | PostgreSQL connection string |
| Pool max | 20 | nova-kata connection pool |
| Pool max | 10 | nova-kata-gateway connection pool |

### 6.3 Warm Pool

| Variable | Default | Description |
|---|---|---|
| `WARM_POOL_MIN` | 2 | Minimum paused containers per function |
| `WARM_POOL_MAX` | 10 | Maximum pool size |
| `WARM_POOL_REPLENISH_INTERVAL_MS` | 15000 | Replenish check interval |

### 6.4 Timeouts and Health

| Variable | Default | Description |
|---|---|---|
| `SSH_CONNECT_TIMEOUT` | 10000 ms | SSH connection timeout |
| `SSH_EXEC_TIMEOUT` | 30000 ms | SSH command timeout |
| `REQUEST_TIMEOUT_MS` | 60000 ms | Gateway request timeout |
| `HEALTH_CHECK_INTERVAL_MS` | 30000 ms | Worker health check interval |
| `MAX_CONSECUTIVE_FAILURES` | 3 | Failures before worker unhealthy |
| `WORKER_RECOVERY_MAX_FAILURES` | 10 | Failures before worker retired |

### 6.5 Rate Limiting

| Variable | Default | Description |
|---|---|---|
| `RATE_LIMIT_PER_SEC` | 100 | Per-IP rate limit |
| `FUNCTION_RATE_LIMIT` | 50 | Per-function rate limit |
| Rate limit window | 1000 ms | Fixed window |

### 6.6 Caching

| Variable | Default | Description |
|---|---|---|
| `FUNCTION_CACHE_TTL` | 3600 s | Function metadata cache TTL |
| `CONTAINER_CACHE_TTL` | 300 s | Container state cache TTL |
| `REDIS_URL` | (optional) | Redis URL for shared cache |

### 6.7 Build and Registry

| Variable | Default | Description |
|---|---|---|
| `REGISTRY_HOST` | localhost:5000 | OCI registry host:port |
| Base64 chunk size | 2000 chars | SSH file transfer chunk size |
| Multer file limit | 50 MB | Max upload size |
| Compression threshold | 1024 B | Response compression threshold |

### 6.8 GCP Scaling

| Variable | Default | Description |
|---|---|---|
| `SCALE_OUT_THRESHOLD` | 0.75 | Utilization threshold |
| `MAX_WORKERS` | 1 | Max worker VMs |
| `SCALE_OUT_COOLDOWN_MIN` | 10 | Cooldown between scale-outs |
| `GCP_MACHINE_TYPE` | n2-standard-2 | VM type |
| `GCP_DISK_SIZE_GB` | 100 | Boot disk size |
| `GCP_DEFAULT_REGION` | us | Default region |

---

## 7. Known Limitations

Each limitation is stated precisely, then mapped to a future-work item in section 8.

| # | Limitation | Impact | Future work |
|---|---|---|---|
| 1 | No SSH connection pooling | 50–150 ms handshake per command | SSH multiplexing or persistent connections |
| 2 | PostgreSQL SPOF | Single database instance, no replication | Streaming replication + failover |
| 3 | Nginx race condition | Stale IPs under high container churn | Atomic config generation with locking |
| 4 | RAM consumption | 256–1280 MB reserved for paused containers | Dynamic pool sizing based on demand |
| 5 | No horizontal control plane scaling | Single nova-kata instance | Leader election + shared state |
| 6 | No connection draining on placement restart | In-flight builds may fail | Graceful shutdown with drain |
| 7 | Worker API security | Single API key, no TLS | mTLS + per-worker certificates |
| 8 | No function versioning | Single version per function name | Version/alias routing |
| 9 | GCP vendor lock-in | Scaling only on Compute Engine | Abstract cloud provider interface |

---

## 8. What Is NOT in the Codebase (Future Work)

Features absent from the current implementation, listed with their rationale and complexity.

| Feature | Rationale for absence | Complexity |
|---|---|---|
| Horizontal gateway scaling | Redis shared state exists but no load balancer config | Medium — needs LB + session affinity |
| Function versioning/alias routing | Single `latest` tag per function | Medium — schema change + routing logic |
| Per-function resource quota enforcement | `memory_limit`, `cpu_limit` stored but not passed to `nerdctl run` | Low — add flags to launch command |
| Container health check from gateway | Only placement service monitors worker health | Medium — periodic HTTP pings |
| Automatic worker retirement on hardware failure | Manual intervention required | Medium — GCP instance status polling |
| Multi-region function deployment | Workers in one region at a time | High — cross-region networking + state sync |
| Function logging/aggregation | Logs only on worker VMs | Medium — Fluentd/Fluent Bit sidecar |
| Billing/metering | No usage tracking | High — invocation counting + pricing model |
| CI/CD pipeline | No automated testing or deployment | Medium — GitHub Actions + integration tests |
| End-to-end encryption | API keys stored plaintext in DB | Medium — encryption at rest + KMS |
| Container image vulnerability scanning | No Trivy/Grype integration | Low — post-build scan step |
