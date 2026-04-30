const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const DB_PATH = process.env.DB_PATH || './data/placement.db';
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

    // Enable WAL-like pragmas (sql.js supports a subset)
    db.run('PRAGMA foreign_keys = ON;');

    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    db.run(schema);

    persist();
    return db;
}

// ─── Query helpers ────────────────────────────────────────────────────────────

/**
 * Execute a SELECT and return all rows as plain objects.
 */
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

/**
 * Execute a SELECT and return the first row.
 */
function queryOne(sql, params = []) {
    const results = queryAll(sql, params);
    return results[0] || null;
}

/**
 * Execute an INSERT / UPDATE / DELETE (with auto-persist).
 */
function run(sql, params = []) {
    db.run(sql, params);
    persist();
}

// ─── Named-param helper ───────────────────────────────────────────────────────
// sql.js uses positional params; we convert @name → value arrays for convenience.
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
            `INSERT INTO workers
         (id, ip, username, password, ssh_port, firecracker_path,
          kernel_image_path, rootfs_path, fc_socket_dir, status)
       VALUES
         (@id, @ip, @username, @password, @ssh_port, @firecracker_path,
          @kernel_image_path, @rootfs_path, @fc_socket_dir, @status)`,
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
};

// ─── microvms ─────────────────────────────────────────────────────────────────

function enrichMicroVM(vm) {
    if (!vm) return vm;
    if (vm.metadata) {
        try {
            const parsed = JSON.parse(vm.metadata);
            if (parsed.host_ip) vm.host_ip = parsed.host_ip;
            if (parsed.host_port) vm.host_port = parsed.host_port;
        } catch(e) {}
    }
    return vm;
}

const microvms = {
    insert(m) {
        const { sql: s, values } = namedToPositional(
            `INSERT INTO microvms
         (id, worker_id, socket_path, kernel_image_path, rootfs_path,
          pid, status, boot_args, metadata)
       VALUES
         (@id, @worker_id, @socket_path, @kernel_image_path, @rootfs_path,
          @pid, @status, @boot_args, @metadata)`,
            m
        );
        run(s, values);
    },

    findAll() {
        return queryAll('SELECT * FROM microvms ORDER BY started_at DESC').map(enrichMicroVM);
    },

    findById(id) {
        return enrichMicroVM(queryOne('SELECT * FROM microvms WHERE id = ?', [id]));
    },

    findByWorker(workerId) {
        return queryAll(
            "SELECT * FROM microvms WHERE worker_id = ? AND status NOT IN ('stopped','failed')",
            [workerId]
        ).map(enrichMicroVM);
    },

    countActiveByWorker(workerId) {
        const row = queryOne(
            "SELECT COUNT(*) as cnt FROM microvms WHERE worker_id = ? AND status IN ('starting','running')",
            [workerId]
        );
        return row ? row.cnt : 0;
    },

    updateStatus(id, status, extra = {}) {
        if (['stopped', 'failed'].includes(status)) {
            run(
                `UPDATE microvms SET status = ?, stopped_at = datetime('now') WHERE id = ?`,
                [status, id]
            );
        } else {
            run('UPDATE microvms SET status = ? WHERE id = ?', [status, id]);
        }
        if (extra.pid !== undefined && extra.pid !== null) {
            run('UPDATE microvms SET pid = ? WHERE id = ?', [extra.pid, id]);
        }
    },

    delete(id) {
        run('DELETE FROM microvms WHERE id = ?', [id]);
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

module.exports = { initDb, getDb, workers, microvms, events };
