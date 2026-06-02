# Nova Kata

Placement Service for containerised serverless functions using **containerd + nerdctl + Kata Containers (QEMU)**.

Replaces the Firecracker-based Placement Nova with a container-based approach using the same architecture.

## Architecture

```
Request → nova-kata-gateway (:8081) → nova-kata (:3002) → SSH → Worker VM
                                                                    ↓
                                                              nerdctl run --runtime kata
                                                                    ↓
                                                              Container (QEMU VM)
                                                                    ↓
                                                              nginx reverse proxy
```

## Warm Pool Strategy

**No cold starts.** Nova Kata maintains a pool of pre-created, paused containers:

1. On startup / after a claim, containers are launched with `nerdctl run` and immediately **paused** (`nerdctl pause`)
2. When a request arrives, a paused container is **unpaused** (`nerdctl unpause`) — near-instant (~50-100ms)
3. The pool is **replenished** in the background after each claim
4. Configurable `WARM_POOL_MIN` and `WARM_POOL_MAX`

## Tech Stack

- **Node.js + Express** — API server
- **SQLite (sql.js)** — persistence
- **SSH2** — remote execution on worker VMs
- **nerdctl** — container management (replaces Firecracker API)
- **Kata Containers (QEMU)** — VM-level isolation per container
- **nginx** — reverse proxy on workers

## API Endpoints

### Workers
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/init` | Register a new worker VM |
| GET | `/workers` | List all workers |
| GET | `/workers/:id` | Get worker details |
| POST | `/workers/:id/check` | Health check a worker |
| POST | `/workers/:id/retire` | Retire a worker |
| DELETE | `/workers/:id` | Delete a worker |

### Containers
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/execute` | Claim warm container or cold-start |
| POST | `/containers/launch` | Manually launch a container |
| POST | `/containers/:id/pause` | Pause a container |
| POST | `/containers/:id/unpause` | Unpause a container |
| GET | `/containers` | List all containers |
| GET | `/containers/:id` | Get container details |
| DELETE | `/containers/:id` | Stop and remove |

### Warm Pool
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/warm-pool` | Pool statistics |
| POST | `/warm-pool/replenish` | Trigger replenishment |

### Functions
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/functions` | Register a function |
| GET | `/functions` | List functions |
| GET | `/functions/:id` | Get function details |
| DELETE | `/functions/:id` | Delete a function |
| POST | `/functions/:id/keys` | Generate API key |

### System
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/metrics` | Pool metrics |

## Quick Start

```bash
# 1. Nova Kata (Placement Service)
cd nova-kata
npm install
npm run dev    # → http://localhost:3002

# 2. Nova Kata Gateway
cd nova-kata-gateway
npm install
npm run dev    # → http://localhost:8081 (public), :3003 (internal)
```

## Worker Setup

Workers need: containerd, nerdctl, Kata Containers, CNI plugins, nginx, runc, BuildKit.

See the setup guide in the parent README.
