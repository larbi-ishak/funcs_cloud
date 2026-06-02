const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const DB_PATH = process.env.DB_PATH || './data/nova-kata.db';
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let db;
let SQL;

function getDb() {
    if (!db) throw new Error('Database not initialised. Call initDb() first.');
    return db;
}

/** Flush in-memory DB to disk. Called after every write. */
function persist() {
    const data = db.export();
    const buffer = Buffer.from(data);
    const absPath = path.resolve(DB_PATH);
    fs.writeFileSync(absPath, buffer);
}

async function initDb() {
    const dbDir = path.dirname(path.resolve(DB_PATH));
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

    SQL = await initSqlJs();

    const absPath = path.resolve(DB_PATH);
    if (fs.existsSync(absPath)) {
        const fileBuffer = fs.readFileSync(absPath);
        db = new SQL.Database(fileBuffer);
        logger.info(`SQLite database loaded from ${absPath}`);
    } else {
        db = new SQL.Database();
        logger.info(`SQLite database created at ${absPath}`);
    }

    db.run('PRAGMA foreign_keys = ON;');

    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    db.run(schema);

    // Run auto-migrations
    try {
        db.run('ALTER TABLE functions ADD COLUMN memory_limit INTEGER DEFAULT 512;');
        logger.info('Migration: Added memory_limit to functions table');
    } catch (e) {}
    try {
        db.run('ALTER TABLE functions ADD COLUMN cpu_limit REAL DEFAULT 1.0;');
        logger.info('Migration: Added cpu_limit to functions table');
    } catch (e) {}
    try {
        db.run('ALTER TABLE functions ADD COLUMN storage_limit INTEGER DEFAULT 512;');
        logger.info('Migration: Added storage_limit to functions table');
    } catch (e) {}
    try {
        db.run('ALTER TABLE functions ADD COLUMN max_containers INTEGER DEFAULT 10;');
        logger.info('Migration: Added max_containers to functions table');
    } catch (e) {}
    try {
        db.run('ALTER TABLE functions ADD COLUMN warm_count INTEGER DEFAULT 1;');
        logger.info('Migration: Added warm_count to functions table');
    } catch (e) {}

    try {
        db.run(`
            CREATE TABLE IF NOT EXISTS invocations (
                id TEXT PRIMARY KEY,
                function_id TEXT NOT NULL,
                container_id TEXT,
                status_code INTEGER,
                latency_ms INTEGER,
                request_method TEXT,
                request_path TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (function_id) REFERENCES functions(id) ON DELETE CASCADE
            );
        `);
    } catch (e) {}

    // GCP auto-scaling metadata
    try {
        db.run('ALTER TABLE workers ADD COLUMN gcp_instance_name TEXT;');
        logger.info('Migration: Added gcp_instance_name to workers table');
    } catch (e) {}
    try {
        db.run('ALTER TABLE workers ADD COLUMN gcp_zone TEXT;');
        logger.info('Migration: Added gcp_zone to workers table');
    } catch (e) {}

    persist();
    return db;
}

// ─── Query helpers ────────────────────────────────────────────────────────────

function queryAll(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
        rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
}

function queryOne(sql, params = []) {
    const results = queryAll(sql, params);
    return results[0] || null;
}

function run(sql, params = []) {
    db.run(sql, params);
    persist();
}

function namedToPositional(sql, obj) {
    const values = [];
    const transformed = sql.replace(/@(\w+)/g, (_, key) => {
        values.push(obj[key] !== undefined ? obj[key] : null);
        return '?';
    });
    return { sql: transformed, values };
}

// ─── workers ──────────────────────────────────────────────────────────────────

const workers = {
    insert(w) {
        const { sql: s, values } = namedToPositional(
            `INSERT INTO workers (id, ip, username, password, ssh_port, status)
             VALUES (@id, @ip, @username, @password, @ssh_port, @status)`,
            w
        );
        run(s, values);
    },

    findAll() {
        return queryAll('SELECT * FROM workers ORDER BY created_at DESC');
    },

    findById(id) {
        return queryOne('SELECT * FROM workers WHERE id = ?', [id]);
    },

    findHealthy() {
        return queryAll("SELECT * FROM workers WHERE status = 'healthy' ORDER BY created_at ASC");
    },

    updateStatus(id, status) {
        run(
            `UPDATE workers SET status = ?, updated_at = datetime('now') WHERE id = ?`,
            [status, id]
        );
    },

    updateLastSeen(id) {
        run(
            `UPDATE workers
             SET last_seen_at = datetime('now'), consecutive_failures = 0,
                 status = 'healthy', updated_at = datetime('now')
             WHERE id = ?`,
            [id]
        );
    },

    incrementFailures(id) {
        run(
            `UPDATE workers
             SET consecutive_failures = consecutive_failures + 1,
                 updated_at = datetime('now')
             WHERE id = ?`,
            [id]
        );
    },

    delete(id) {
        run('DELETE FROM workers WHERE id = ?', [id]);
    },

    setGcpMeta(id, { instanceName, zone }) {
        run(
            `UPDATE workers SET gcp_instance_name = ?, gcp_zone = ?, updated_at = datetime('now') WHERE id = ?`,
            [instanceName, zone, id]
        );
    },
};

// ─── containers ───────────────────────────────────────────────────────────────

const containers = {
    insert(c) {
        const { sql: s, values } = namedToPositional(
            `INSERT INTO containers
             (id, worker_id, container_name, image, runtime, container_ip,
              host_port, agent_port, status, function_id, metadata)
             VALUES
             (@id, @worker_id, @container_name, @image, @runtime, @container_ip,
              @host_port, @agent_port, @status, @function_id, @metadata)`,
            c
        );
        run(s, values);
    },

    findAll() {
        return queryAll('SELECT * FROM containers ORDER BY started_at DESC');
    },

    findById(id) {
        return queryOne('SELECT * FROM containers WHERE id = ?', [id]);
    },

    findByWorker(workerId) {
        return queryAll(
            "SELECT * FROM containers WHERE worker_id = ? AND status NOT IN ('stopped','failed')",
            [workerId]
        );
    },

    findByName(name) {
        return queryOne('SELECT * FROM containers WHERE container_name = ?', [name]);
    },

    countActiveByWorker(workerId) {
        const row = queryOne(
            "SELECT COUNT(*) as cnt FROM containers WHERE worker_id = ? AND status IN ('creating','running','paused')",
            [workerId]
        );
        return row ? row.cnt : 0;
    },

    updateStatus(id, status, extra = {}) {
        if (['stopped', 'failed'].includes(status)) {
            run(
                `UPDATE containers SET status = ?, stopped_at = datetime('now') WHERE id = ?`,
                [status, id]
            );
        } else {
            run('UPDATE containers SET status = ? WHERE id = ?', [status, id]);
        }
        if (extra.container_ip) {
            run('UPDATE containers SET container_ip = ? WHERE id = ?', [extra.container_ip, id]);
        }
        if (extra.host_port) {
            run('UPDATE containers SET host_port = ? WHERE id = ?', [extra.host_port, id]);
        }
    },

    delete(id) {
        run('DELETE FROM containers WHERE id = ?', [id]);
    },
};

// ─── warm pool ────────────────────────────────────────────────────────────────

const warmPool = {
    insert(entry) {
        const { sql: s, values } = namedToPositional(
            `INSERT INTO warm_pool (container_id, worker_id, function_id, status)
             VALUES (@container_id, @worker_id, @function_id, @status)`,
            entry
        );
        run(s, values);
    },

    /**
     * Claim a warm container for a given function (or any if function_id is null).
     * Returns the warm_pool row + container data.
     */
    claimOne(functionId) {
        let row;
        if (functionId) {
            row = queryOne(
                `SELECT wp.*, c.container_ip, c.host_port, c.worker_id, c.container_name, c.agent_port
                 FROM warm_pool wp
                 JOIN containers c ON c.id = wp.container_id
                 WHERE wp.function_id = ? AND wp.status = 'warm'
                 ORDER BY wp.created_at ASC LIMIT 1`,
                [functionId]
            );
        }
        // Fallback: claim any warm container with no function_id
        if (!row) {
            row = queryOne(
                `SELECT wp.*, c.container_ip, c.host_port, c.worker_id, c.container_name, c.agent_port
                 FROM warm_pool wp
                 JOIN containers c ON c.id = wp.container_id
                 WHERE wp.function_id IS NULL AND wp.status = 'warm'
                 ORDER BY wp.created_at ASC LIMIT 1`,
                []
            );
        }
        if (!row) return null;

        run(
            `UPDATE warm_pool SET status = 'claimed', claimed_at = datetime('now') WHERE id = ?`,
            [row.id]
        );
        return row;
    },

    countWarm(functionId) {
        if (functionId) {
            const row = queryOne(
                "SELECT COUNT(*) as cnt FROM warm_pool WHERE (function_id = ? OR function_id IS NULL) AND status = 'warm'",
                [functionId]
            );
            return row ? row.cnt : 0;
        }
        const row = queryOne(
            "SELECT COUNT(*) as cnt FROM warm_pool WHERE status = 'warm'",
            []
        );
        return row ? row.cnt : 0;
    },

    countAll() {
        const row = queryOne("SELECT COUNT(*) as cnt FROM warm_pool WHERE status = 'warm'", []);
        return row ? row.cnt : 0;
    },

    findAll() {
        return queryAll(
            `SELECT wp.*, c.container_name, c.container_ip, c.status as container_status
             FROM warm_pool wp
             JOIN containers c ON c.id = wp.container_id
             ORDER BY wp.created_at DESC`
        );
    },

    deleteByContainer(containerId) {
        run('DELETE FROM warm_pool WHERE container_id = ?', [containerId]);
    },

    findByContainer(containerId) {
        return queryOne('SELECT * FROM warm_pool WHERE container_id = ?', [containerId]);
    },

    markWarm(containerId) {
        run(`UPDATE warm_pool SET status = 'warm', claimed_at = NULL WHERE container_id = ?`, [containerId]);
        // Also update the container record back to paused
        run(`UPDATE containers SET status = 'paused' WHERE id = ?`, [containerId]);
    },

    removeByFunctionId(functionId) {
        run('DELETE FROM warm_pool WHERE function_id = ?', [functionId]);
    },
};

// ─── events ───────────────────────────────────────────────────────────────────

const events = {
    insert(e) {
        const { sql: s, values } = namedToPositional(
            `INSERT INTO worker_events (worker_id, event_type, message)
             VALUES (@worker_id, @event_type, @message)`,
            e
        );
        run(s, values);
    },

    findByWorker(workerId) {
        return queryAll(
            'SELECT * FROM worker_events WHERE worker_id = ? ORDER BY created_at DESC LIMIT 50',
            [workerId]
        );
    },
};

// ─── functions ────────────────────────────────────────────────────────────────

const functions = {
    insert(f) {
        const { sql: s, values } = namedToPositional(
            `INSERT INTO functions (id, name, image, region, agent_cmd, agent_port, env_vars, memory_limit, cpu_limit, storage_limit, max_containers, warm_count, status, auth_policy)
             VALUES (@id, @name, @image, @region, @agent_cmd, @agent_port, @env_vars, @memory_limit, @cpu_limit, @storage_limit, @max_containers, @warm_count, @status, @auth_policy)`,
            f
        );
        run(s, values);
    },

    findAll() {
        return queryAll('SELECT * FROM functions ORDER BY created_at DESC');
    },

    findById(id) {
        return queryOne('SELECT * FROM functions WHERE id = ?', [id]);
    },

    findByNameAndRegion(name, region) {
        return queryOne('SELECT * FROM functions WHERE name = ? AND region = ?', [name, region]);
    },

    updateStatus(id, status) {
        run(`UPDATE functions SET status = ?, updated_at = datetime('now') WHERE id = ?`, [status, id]);
    },

    delete(id) {
        run('DELETE FROM functions WHERE id = ?', [id]);
    },

    deleteById(id) {
        run('DELETE FROM functions WHERE id = ?', [id]);
    },
};

// ─── api_keys ─────────────────────────────────────────────────────────────────

const apiKeys = {
    insert(k) {
        const { sql: s, values } = namedToPositional(
            `INSERT INTO api_keys (id, key, function_id, status)
             VALUES (@id, @key, @function_id, @status)`,
            k
        );
        run(s, values);
    },

    findByKey(key) {
        return queryOne('SELECT * FROM api_keys WHERE key = ? AND status = "active"', [key]);
    },

    findByFunction(functionId) {
        return queryAll('SELECT * FROM api_keys WHERE function_id = ?', [functionId]);
    },
};

const invocations = {
    insert(inv) {
        const { sql: s, values } = namedToPositional(
            `INSERT INTO invocations (id, function_id, container_id, status_code, latency_ms, request_method, request_path)
             VALUES (@id, @function_id, @container_id, @status_code, @latency_ms, @request_method, @request_path)`,
            inv
        );
        run(s, values);
    },
    findByFunction(functionId) {
        return queryAll('SELECT * FROM invocations WHERE function_id = ? ORDER BY created_at DESC', [functionId]);
    }
};

module.exports = { initDb, getDb, workers, containers, warmPool, events, functions, apiKeys, invocations };
