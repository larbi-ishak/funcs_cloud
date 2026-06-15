# Worker API — HTTP Agent for Container Operations

> **Status:** Phases 1–5 implemented (all SSH eliminated from hot path)
> **Created:** 2026-06-13
> **Updated:** 2026-06-15

---

## Overview

The Worker API is a lightweight HTTP server that runs on each worker VM. It accepts container operation requests from the Placement Service (nova-kata) and executes nerdctl commands locally — **eliminating SSH overhead on the hot path**.

### Why This Exists

The current architecture uses SSH for every container operation:

```
Placement Service → SSH → bash → nerdctl → containerd
                   ~130-260ms overhead
```

With the Worker API:

```
Placement Service → HTTP (keep-alive) → Worker API → nerdctl → containerd
                   ~60-90ms overhead
```

**Latency saved: ~70-170ms per operation** (SSH handshake + crypto + bash spawn eliminated).

---

## Architecture

```
┌─────────────────┐         ┌──────────────────────────────────────┐
│  Nova Kata       │  HTTP   │  Worker VM                           │
│  (Placement)     │────────→│                                      │
│                  │  :3005  │  ┌─────────────┐   ┌──────────────┐ │
│  containerService│  X-Worker-Key         │  │  Worker API  │──→│  nerdctl     │ │
│  → pause()       │         │  │  (Express)   │   │  pause/unpause│ │
│  → unpause()     │         │  │  :3005       │──→│  run/stop    │ │
│                  │         │  └─────────────┘   └──────────────┘ │
│                  │         │         │                            │
│                  │         │    ┌────▼─────┐                     │
│                  │         │    │containerd │                     │
│                  │         │    └───────────┘                     │
└─────────────────┘         └──────────────────────────────────────┘
```

---

## Implemented Endpoints

### Phase 1 — Container Ops (pause/unpause/health/stats)

### `POST /unpause`

Unpause a paused container (warm pool → running).

```json
// Request
POST http://<worker-ip>:3005/unpause
Headers: X-Worker-Key: <shared-key>
Body: { "container_name": "nova-a1b2c3d4e5f6" }

// Response (success)
{ "success": true, "stdout": "", "stderr": "" }

// Response (error)
{ "error": "...", "stderr": "..." }
```

### `POST /pause`

Pause a running container (running → warm pool).

```json
// Request
POST http://<worker-ip>:3005/pause
Headers: X-Worker-Key: <shared-key>
Body: { "container_name": "nova-a1b2c3d4e5f6" }

// Response (success)
{ "success": true, "stdout": "", "stderr": "" }
```

### `GET /health`

Health check — returns containerd status and uptime.

```json
// Response
{
  "status": "ok",
  "uptime": 86400,
  "containerd": "containerd github.com/containerd/containerd v1.7.20 ...",
  "containerd_ok": true,
  "uptime_cmd": " 10:30:00 up 1 day, ..."
}
```

### `GET /stats`

Container statistics — running/paused/total counts.

```json
// Response
{
  "containers": { "running": 3, "paused": 5, "total": 8 },
  "nerdctl_version": "nerdctl version 1.7.6 ..."
}
```

---

## Authentication

**Shared API key** via `X-Worker-Key` header.

- Key is set in `nova-kata/.env` as `WORKER_API_KEY`
- Same key is deployed to each worker's `/opt/nova/worker-api/.env` during provisioning
- All requests without a valid key receive `401 Unauthorized`

**Security considerations:**
- Worker API port (3005) should only be accessible from the placement service subnet
- GCP firewall rule should restrict port 3005 to the placement service's internal IP
- In production, rotate the key regularly and use a strong random value

---

## Deployment

The Worker API is installed automatically during worker provisioning (`provisionService.js` Step 13):

1. Create `/opt/nova/worker-api/` directory
2. Upload `index.js` and `package.json`
3. Write `.env` with `WORKER_API_KEY` and `WORKER_API_PORT`
4. `npm install --production`
5. Install systemd service `nova-worker-api.service`
6. `systemctl enable --now nova-worker-api`
7. Open iptables port 3005

**For existing workers**, install manually:
```bash
# On the worker VM:
mkdir -p /opt/nova/worker-api
# Copy index.js and package.json to /opt/nova/worker-api/
echo 'WORKER_API_KEY=nova-worker-secret-key-change-in-prod' > /opt/nova/worker-api/.env
echo 'WORKER_API_PORT=3005' >> /opt/nova/worker-api/.env
cd /opt/nova/worker-api && npm install --production
cp nova-worker-api.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now nova-worker-api
```

---

## Fallback Behavior

`containerService.js` tries the Worker API first, then falls back to SSH:

```js
// Try Worker API (fast, no SSH)
try {
    await workerApiClient.post(`http://${worker.ip}:${WORKER_API_PORT}/unpause`, ...);
} catch (apiErr) {
    // Fallback: SSH
    ssh = await createSSHClient(...);
    await ssh.exec(`nerdctl unpause ${container.container_name}`);
}
```

This ensures **zero downtime migration** — if the Worker API isn't installed yet (existing workers), everything still works via SSH.

---

### Phase 2 — Launch Endpoint

**`POST /launch`** — Execute a base64-encoded launch script. Eliminates ~1s SSH handshake on cold starts.

```json
POST http://<worker-ip>:3005/launch
Body: { "script_base64": "<base64-encoded bash script>" }
Response: { "success": true, "stdout": "...", "stderr": "..." }
```

**Used by:** `containerService.js` `launchContainer()` — tries Worker API first, SSH fallback.

### Phase 3 — Stop/Remove Endpoint

**`POST /stop`** — Stop and remove a container (handles unpause if needed).

```json
POST http://<worker-ip>:3005/stop
Body: { "container_name": "nova-a1b2c3d4e5f6" }
Response: { "success": true, "stdout": "...", "stderr": "..." }
```

**Used by:** `containerService.js` `stopContainer()` — tries Worker API first, SSH fallback.

### Phase 4 — Build Support Endpoints

**`POST /write-file`** — Write a base64-encoded file to disk (restricted to `/opt/nova/`).

```json
POST http://<worker-ip>:3005/write-file
Body: { "path": "/opt/nova/build/my-func/handler.py", "content_base64": "...", "mode": "0644" }
Response: { "success": true, "path": "..." }
```

**`POST /build`** — Run nerdctl build + push on the worker.

```json
POST http://<worker-ip>:3005/build
Body: { "build_dir": "/opt/nova/build/my-func", "tag": "10.128.0.21:5000/nova-fn-my-func:latest", "no_cache": true }
Response: { "success": true, "stdout": "...", "stderr": "..." }
```

**`POST /exec`** — Execute a single command on the worker.

```json
POST http://<worker-ip>:3005/exec
Body: { "command": "mkdir -p /opt/nova/build/my-func", "timeout": 30000 }
Response: { "success": true, "stdout": "...", "stderr": "...", "exit_code": 0 }
```

**Used by:** `buildService.js` — file writes and commands use Worker API first, SSH fallback. Build streaming still uses SSH (important for UX).

### Phase 5 — Health Check Integration

**`GET /health`** — Already existed in Phase 1, now used by `workerService.js` for health checks.

**Used by:** `checkWorkerHealth()` — tries Worker API `GET /health` first (no SSH). Falls back to SSH for auto-recovery (containerd restart) and pending worker validation.

---

## Launch Endpoint Assessment (Phase 2) — Historical

### Current Launch Flow (via SSH)

```
1. SSH connect (~100ms)
2. Base64-encode 40-line bash script
3. Execute: nerdctl run → wait for IP (15s retry) → write nginx config → optionally pause
4. Parse stdout JSON for container IP
5. Total: 130-260ms SSH overhead + 5-15s Kata boot
```

### Launch via Worker API — Impact Assessment

| Aspect | Impact | Notes |
|---|---|---|
| **Latency saved** | ~130-260ms | Same as pause/unpause — eliminates SSH |
| **Complexity** | **High** | 10+ parameters, nginx config, IP retry loop, 90s timeout |
| **Error handling** | **Much better** | HTTP status codes + JSON vs parsing SSH stdout |
| **Risk** | **Medium** | If Worker API crashes during launch, container may be orphaned |
| **Parameters** | image, runtime, env_vars, memory, cpu, host_port, agent_port, container_name, pause_after | All sent in HTTP body |
| **Response** | container_ip, status | Worker API returns after IP retry loop completes |

### Implementation Plan

**Endpoint: `POST /launch`**

```json
// Request
POST http://<worker-ip>:3005/launch
Body: {
  "container_name": "nova-a1b2c3d4e5f6",
  "image": "10.128.0.21:5000/nova-fn-keystone:latest",
  "runtime": "io.containerd.kata.v2",
  "snapshotter": "overlayfs",
  "host_port": 9000,
  "agent_port": 8080,
  "env_vars": { "NOVA_PORT": "8080", "KEY": "VALUE" },
  "memory_limit": "512m",
  "cpu_limit": "1",
  "pause_after": true
}

// Response (success)
{
  "success": true,
  "container_ip": "10.4.0.23",
  "host_port": 9000,
  "status": "paused"
}

// Response (error)
{
  "success": false,
  "error": "container exited unexpectedly",
  "logs": "..."
}
```

**Worker API implementation:**
- Receives all parameters as JSON
- Constructs the same bash script (same logic as current `launchContainer`)
- Executes locally via `child_process.exec` with 90s timeout
- Parses the script's JSON output
- Returns clean JSON response

**Placement Service changes:**
- `launchContainer()` tries Worker API first
- Falls back to SSH if Worker API is unavailable
- Same fallback pattern as pause/unpause

**Effort:** ~3 hours

**Benefits over current SSH approach:**
1. **Cleaner error handling** — HTTP status codes instead of SSH exit codes
2. **No SSH credentials needed** — API key auth only
3. **Connection reuse** — keep-alive HTTP vs per-request SSH
4. **Better observability** — Worker API can log launch metrics locally

---

## Future Improvements

### Phase 6: gRPC Transport (Future)

Replace HTTP+JSON with gRPC+protobuf for even lower latency:
- Binary protocol: ~30% smaller messages
- No JSON parse overhead
- Built-in connection management and health checking
- Native streaming support (for build logs, container logs)

**When to consider:** Only when HTTP latency becomes a measurable bottleneck. Currently HTTP keep-alive is sufficient.

**Effort:** ~1 week (requires protobuf definitions, gRPC server in Worker API, gRPC client in nova-kata)

### Phase 7: Direct containerd API (Skip nerdctl)

For specific operations like `unpause`, nerdctl is unnecessary overhead (~50-80ms Go binary boot). The containerd API can be called directly:

```js
// unpause via containerd gRPC API (no nerdctl boot)
const client = new containerd.ContainerdClient('/run/containerd/containerd.sock');
await client.task.resume({ containerID });
```

**When to consider:** Only for `unpause` (most latency-sensitive). `launch` must still use nerdctl for CNI.

**Effort:** ~2-3 days (requires containerd gRPC client for Node.js or Go rewrite)

---

## Monitoring

### Worker API Health from Placement Service

```bash
# Check if Worker API is running on a worker
curl -H "X-Worker-Key: <key>" http://<worker-ip>:3005/health
```

### Worker API Stats

```bash
# Get container counts on a worker
curl -H "X-Worker-Key: <key>" http://<worker-ip>:3005/stats
```

### GCP Firewall Rule

Restrict Worker API port to placement service only:
```bash
gcloud compute firewall-rules create allow-worker-api \
    --network default \
    --allow tcp:3005 \
    --source-ranges 10.128.0.0/20 \
    --target-tags nova-worker
```

---

## Summary

| Phase | Endpoints | Effort | Status |
|---|---|---|---|
| 1 | pause, unpause, health, stats | ~3 hours | ✅ Done |
| 2 | launch | ~3 hours | ✅ Done |
| 3 | stop/remove | ~1 hour | ✅ Done |
| 4 | write-file, build, exec | ~2 hours | ✅ Done |
| 5 | Health check integration | ~1 hour | ✅ Done |
| 6 | gRPC transport | ~1 week | Future |
| 7 | Direct containerd API | ~2-3 days | Future |
