# Nova Placement Service

> **Node.js microservice** for managing Worker VMs and Firecracker MicroVMs in a serverless platform.

---

## Quick Start

```bash
npm install
npm run dev        # development (nodemon)
npm start          # production
```

Service runs on `http://localhost:3000` by default.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./data/placement.db` | SQLite database path |
| `HEALTH_CHECK_INTERVAL_MS` | `30000` | Worker health check interval |
| `MAX_CONSECUTIVE_FAILURES` | `3` | Failures before marking worker `faulty` |
| `SSH_CONNECT_TIMEOUT` | `10000` | SSH connect timeout (ms) |
| `SSH_EXEC_TIMEOUT` | `30000` | SSH exec timeout (ms) |
| `DEFAULT_FIRECRACKER_PATH` | `/usr/local/bin/firecracker` | Default FC binary path |
| `DEFAULT_KERNEL_IMAGE_PATH` | `/root/lab/hello-vmlinux.bin` | Default kernel image path |
| `DEFAULT_ROOTFS_PATH` | `/root/lab/hello-rootfs.ext4` | Default rootfs path |
| `FC_SOCKET_DIR` | `/tmp/fc-sockets` | Directory for FC unix sockets on worker |

---

## API Reference

### Worker Management

#### `POST /init`
Register and validate a new Worker VM. Performs SSH connection, binary checks, and file checks.

**Body:**
```json
{
  "ip": "192.168.1.10",
  "username": "root",
  "password": "secret",
  "ssh_port": 22,
  "firecracker_path": "/usr/local/bin/firecracker",
  "kernel_image_path": "/root/lab/hello-vmlinux.bin",
  "rootfs_path": "/root/lab/hello-rootfs.ext4",
  "fc_socket_dir": "/tmp/fc-sockets"
}
```
> `ssh_port`, `firecracker_path`, `kernel_image_path`, `rootfs_path`, `fc_socket_dir` are all optional — fall back to env defaults.

**Response `201`:**
```json
{
  "success": true,
  "worker": { "id": "...", "ip": "...", "status": "healthy", ... }
}
```

**Error codes:**
| Code | Meaning |
|---|---|
| `SSH_CONNECT_FAILED` | Could not SSH into the VM |
| `FC_BINARY_MISSING` | `firecracker_path` not found |
| `FC_BINARY_NOT_EXECUTABLE` | Binary exists but won't run |
| `KERNEL_IMAGE_MISSING` | Kernel image not found |
| `ROOTFS_MISSING` | Root filesystem not found |

---

#### `GET /workers`
List all workers.

#### `GET /workers/:id`
Get worker details, recent events, and active MicroVMs.

#### `POST /workers/:id/check`
Manually trigger a health check.

#### `POST /workers/:id/retire`
Retire a worker. Body: `{ "remove": true }` to also delete it.

#### `DELETE /workers/:id`
Hard delete a worker record.

---

### MicroVM Execution

#### `POST /execute`
Launch a new MicroVM. The scheduler picks the least-loaded healthy worker automatically.

**Body (all optional):**
```json
{
  "worker_id": "pin-to-specific-worker-uuid",
  "boot_args": "console=ttyS0 reboot=k panic=1 pci=off",
  "metadata": { "function_id": "fn-abc123" }
}
```

**Response `201`:**
```json
{
  "success": true,
  "microvm": {
    "id": "...",
    "worker_id": "...",
    "socket_path": "/tmp/fc-sockets/<id>.sock",
    "pid": 12345,
    "status": "running",
    ...
  }
}
```

#### `GET /microvms`
List all MicroVMs.

#### `GET /microvms/:id`
Get MicroVM details.

#### `DELETE /microvms/:id`
Stop and clean up a MicroVM (sends `SendCtrlAltDel` then SIGTERM).

---

### System

#### `GET /health`
Service liveness check.

#### `GET /metrics`
Worker pool summary:
```json
{
  "total_workers": 3,
  "by_status": { "healthy": 2, "faulty": 1 },
  "total_active_microvms": 7
}
```

---

## Architecture

```
POST /init
  └── SSH connect → check FC binary → check images → persist DB

POST /execute
  └── Scheduler (least-loaded worker)
       └── SSH → start firecracker --api-sock <socket>
            └── curl --unix-socket → PUT /boot-source
            └── curl --unix-socket → PUT /drives/rootfs
            └── curl --unix-socket → PUT /actions (InstanceStart)

Background Monitoring (every 30s)
  └── SSH uptime + binary check → update worker status
       └── 3 consecutive failures → mark faulty
```

---

## Worker VM Requirements

The target Worker VMs must have:
- SSH access (password auth)
- [`firecracker`](https://github.com/firecracker-microvm/firecracker) binary installed
- Amazon Firecracker hello-world assets:
  - `hello-vmlinux.bin`
  - `hello-rootfs.ext4`
- `curl` installed (used to talk to FC API via unix socket)
- `/tmp/fc-sockets/` directory writable (created automatically on init)

---

## Database

SQLite at `./data/placement.db` (auto-created on first run).

Tables: `workers`, `microvms`, `worker_events`
