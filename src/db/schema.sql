CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  ip TEXT NOT NULL,
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  ssh_port INTEGER NOT NULL DEFAULT 22,
  firecracker_path TEXT NOT NULL,
  kernel_image_path TEXT NOT NULL,
  rootfs_path TEXT NOT NULL,
  fc_socket_dir TEXT NOT NULL DEFAULT '/tmp/fc-sockets',
  status TEXT NOT NULL DEFAULT 'initializing',
  -- status: initializing | healthy | degraded | faulty | retired
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_seen_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT (datetime('now')),
  updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS microvms (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  socket_path TEXT NOT NULL,
  kernel_image_path TEXT NOT NULL,
  rootfs_path TEXT NOT NULL,
  pid INTEGER,
  status TEXT NOT NULL DEFAULT 'starting',
  -- status: starting | running | stopped | failed
  boot_args TEXT NOT NULL DEFAULT 'console=ttyS0 reboot=k panic=1 pci=off',
  metadata TEXT,             -- JSON blob for future use (function id, tags, etc)
  started_at DATETIME NOT NULL DEFAULT (datetime('now')),
  stopped_at DATETIME
);

CREATE TABLE IF NOT EXISTS worker_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,  -- init_success | init_fail | health_ok | health_fail | retired
  message TEXT,
  created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS functions (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  region      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',  -- active | inactive | deleted
  auth_policy TEXT NOT NULL DEFAULT 'public',  -- public | private
  created_at  DATETIME NOT NULL DEFAULT (datetime('now')),
  updated_at  DATETIME NOT NULL DEFAULT (datetime('now')),
  UNIQUE(name, region)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  function_id TEXT NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'active',  -- active | revoked
  created_at  DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vm_instances (
  id          TEXT PRIMARY KEY,
  function_id TEXT NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
  host_ip     TEXT NOT NULL,
  vm_ip       TEXT,
  port        INTEGER NOT NULL,
  host_port   INTEGER,
  status      TEXT NOT NULL DEFAULT 'warm',  -- warm | cold | terminated
  created_at  DATETIME NOT NULL DEFAULT (datetime('now')),
  updated_at  DATETIME NOT NULL DEFAULT (datetime('now'))
);
