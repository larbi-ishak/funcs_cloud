-- PostgreSQL schema for Nova Kata
-- Migrated from SQLite: datetime('now') → CURRENT_TIMESTAMP, AUTOINCREMENT → SERIAL, ? → $1

-- workers table
CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY,
    ip TEXT NOT NULL,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    ssh_port INTEGER NOT NULL DEFAULT 22,
    status TEXT NOT NULL DEFAULT 'unknown',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMPTZ,
    consecutive_failures INTEGER DEFAULT 0,
    gcp_instance_name TEXT,
    gcp_zone TEXT
);

-- functions table
CREATE TABLE IF NOT EXISTS functions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    image TEXT NOT NULL,
    region TEXT NOT NULL,
    agent_cmd TEXT,
    agent_port INTEGER,
    env_vars TEXT,
    memory_limit INTEGER DEFAULT 512,
    cpu_limit REAL DEFAULT 1.0,
    storage_limit INTEGER DEFAULT 512,
    max_containers INTEGER DEFAULT 10,
    warm_count INTEGER DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active',
    auth_policy TEXT NOT NULL DEFAULT 'public',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- api_keys table
CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    function_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (function_id) REFERENCES functions(id) ON DELETE CASCADE
);

-- containers table (represents a Kata container running on a worker)
CREATE TABLE IF NOT EXISTS containers (
    id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL,
    container_name TEXT NOT NULL,
    image TEXT NOT NULL,
    runtime TEXT NOT NULL,
    container_ip TEXT,
    host_port INTEGER,
    agent_port INTEGER,
    status TEXT NOT NULL DEFAULT 'creating',
    function_id TEXT,
    metadata TEXT,
    started_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    stopped_at TIMESTAMPTZ,
    FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE,
    FOREIGN KEY (function_id) REFERENCES functions(id) ON DELETE SET NULL
);

-- warm_pool table – tracks paused containers ready for reuse
CREATE TABLE IF NOT EXISTS warm_pool (
    id SERIAL PRIMARY KEY,
    container_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    function_id TEXT,
    status TEXT NOT NULL DEFAULT 'warm',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    claimed_at TIMESTAMPTZ,
    FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE CASCADE,
    FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE,
    FOREIGN KEY (function_id) REFERENCES functions(id) ON DELETE SET NULL
);

-- worker_events table – audit log for workers
CREATE TABLE IF NOT EXISTS worker_events (
    id SERIAL PRIMARY KEY,
    worker_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    message TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE
);

-- invocations table - tracks function execution history
CREATE TABLE IF NOT EXISTS invocations (
    id TEXT PRIMARY KEY,
    function_id TEXT NOT NULL,
    container_id TEXT,
    status_code INTEGER,
    latency_ms INTEGER,
    request_method TEXT,
    request_path TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (function_id) REFERENCES functions(id) ON DELETE CASCADE
);

-- Migration tracking table
CREATE TABLE IF NOT EXISTS pg_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);