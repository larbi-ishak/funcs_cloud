const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://nova_kata:nova_kata_secret@localhost:5432/nova_kata';
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let pool;

function getDb() {
    if (!pool) throw new Error('Database not initialised. Call initDb() first.');
    return pool;
}

async function initDb() {
    pool = new Pool({ connectionString: DATABASE_URL, max: 20 });

    // Test connection
    const client = await pool.connect();
    try {
        await client.query('SELECT 1');
        logger.info(`PostgreSQL connected: ${DATABASE_URL.replace(/:[^:@]+@/, ':****@')}`);
    } finally {
        client.release();
    }

    // Run schema
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    await pool.query(schema);
    logger.info('PostgreSQL schema applied');

    // Run tracked migrations (idempotent — each runs only once)
    const migrations = [
        {
            name: 'fix_legacy_image_tags',
            async run() {
                const legacyImages = await queryAll(
                    "SELECT id, image FROM functions WHERE image IS NOT NULL AND image NOT LIKE '%/%'"
                );
                if (legacyImages.length > 0) {
                    const registryHost = process.env.REGISTRY_HOST || 'localhost:5000';
                    for (const row of legacyImages) {
                        await run('UPDATE functions SET image = $1 WHERE id = $2', [`${registryHost}/${row.image}`, row.id]);
                    }
                    logger.info(`Migration: Updated ${legacyImages.length} function(s) with registry-prefixed image tags`);
                }
            },
        },
    ];

    for (const m of migrations) {
        const exists = await queryOne("SELECT 1 FROM pg_migrations WHERE name = $1", [m.name]);
        if (!exists) {
            await m.run();
            await run("INSERT INTO pg_migrations (name) VALUES ($1)", [m.name]);
            logger.info(`Migration applied: ${m.name}`);
        }
    }

    return pool;
}

// ─── Query helpers ────────────────────────────────────────────────────────────

async function queryAll(sql, params = []) {
    const result = await pool.query(sql, params);
    return result.rows;
}

async function queryOne(sql, params = []) {
    const result = await pool.query(sql, params);
    return result.rows[0] || null;
}

async function run(sql, params = []) {
    await pool.query(sql, params);
}

function namedToPositional(sql, obj) {
    const values = [];
    let idx = 1;
    const transformed = sql.replace(/@(\w+)/g, (_, key) => {
        values.push(obj[key] !== undefined ? obj[key] : null);
        return `$${idx++}`;
    });
    return { sql: transformed, values };
}

// ─── workers ──────────────────────────────────────────────────────────────────

const workers = {
    async insert(w) {
        const { sql: s, values } = namedToPositional(
            `INSERT INTO workers (id, ip, username, password, ssh_port, status)
             VALUES (@id, @ip, @username, @password, @ssh_port, @status)`,
            w
        );
        await run(s, values);
    },

    async findAll() {
        return queryAll('SELECT * FROM workers ORDER BY created_at DESC');
    },

    async findById(id) {
        return queryOne('SELECT * FROM workers WHERE id = $1', [id]);
    },

    async findHealthy() {
        return queryAll("SELECT * FROM workers WHERE status = 'healthy' ORDER BY created_at ASC");
    },

    async updateStatus(id, status) {
        await run(
            `UPDATE workers SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [status, id]
        );
    },

    async updateLastSeen(id) {
        await run(
            `UPDATE workers
             SET last_seen_at = CURRENT_TIMESTAMP, consecutive_failures = 0,
                 status = 'healthy', updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [id]
        );
    },

    async incrementFailures(id) {
        await run(
            `UPDATE workers
             SET consecutive_failures = consecutive_failures + 1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [id]
        );
    },

    async resetFailures(id) {
        await run(
            `UPDATE workers
             SET consecutive_failures = 0,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [id]
        );
    },

    async delete(id) {
        await run('DELETE FROM workers WHERE id = $1', [id]);
    },

    async setGcpMeta(id, { instanceName, zone }) {
        await run(
            `UPDATE workers SET gcp_instance_name = $1, gcp_zone = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
            [instanceName, zone, id]
        );
    },
};

// ─── containers ───────────────────────────────────────────────────────────────

const containers = {
    async insert(c) {
        const { sql: s, values } = namedToPositional(
            `INSERT INTO containers
             (id, worker_id, container_name, image, runtime, container_ip,
              host_port, agent_port, status, function_id, metadata, started_at)
             VALUES
             (@id, @worker_id, @container_name, @image, @runtime, @container_ip,
              @host_port, @agent_port, @status, @function_id, @metadata, @started_at)`,
            c
        );
        await run(s, values);
    },

    async findAll() {
        return queryAll('SELECT * FROM containers ORDER BY started_at DESC');
    },

    async findById(id) {
        return queryOne('SELECT * FROM containers WHERE id = $1', [id]);
    },

    async findByWorker(workerId) {
        return queryAll(
            "SELECT * FROM containers WHERE worker_id = $1 AND status NOT IN ('stopped','failed')",
            [workerId]
        );
    },

    async findByName(name) {
        return queryOne('SELECT * FROM containers WHERE container_name = $1', [name]);
    },

    async countActiveByWorker(workerId) {
        const row = await queryOne(
            "SELECT COUNT(*) as cnt FROM containers WHERE worker_id = $1 AND status IN ('creating','running','paused')",
            [workerId]
        );
        return row ? parseInt(row.cnt) : 0;
    },

    async updateStatus(id, status, extra = {}) {
        const isTerminal = ['stopped', 'failed'].includes(status);
        await run(
            `UPDATE containers SET
                status = $1,
                container_ip = COALESCE($2, container_ip),
                host_port = COALESCE($3, host_port),
                started_at = COALESCE($4, started_at),
                stopped_at = CASE WHEN $5 THEN CURRENT_TIMESTAMP ELSE stopped_at END
             WHERE id = $6`,
            [status, extra.container_ip || null, extra.host_port || null, extra.started_at || null, isTerminal ? 1 : 0, id]
        );
    },

    async delete(id) {
        await run('DELETE FROM containers WHERE id = $1', [id]);
    },

    async removeByWorkerId(workerId) {
        await run('DELETE FROM containers WHERE worker_id = $1', [workerId]);
    },
};

// ─── warm pool ────────────────────────────────────────────────────────────────

const warmPool = {
    async insert(entry) {
        const { sql: s, values } = namedToPositional(
            `INSERT INTO warm_pool (container_id, worker_id, function_id, status)
             VALUES (@container_id, @worker_id, @function_id, @status)`,
            entry
        );
        await run(s, values);
    },

    async claimOne(functionId) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            let row;
            if (functionId) {
                const result = await client.query(
                    `SELECT wp.*, c.container_ip, c.host_port, c.worker_id, c.container_name, c.agent_port
                     FROM warm_pool wp
                     JOIN containers c ON c.id = wp.container_id
                     WHERE wp.function_id = $1 AND wp.status = 'warm'
                     ORDER BY wp.created_at ASC LIMIT 1
                     FOR UPDATE SKIP LOCKED`,
                    [functionId]
                );
                row = result.rows[0] || null;
            }
            if (!row) {
                const result = await client.query(
                    `SELECT wp.*, c.container_ip, c.host_port, c.worker_id, c.container_name, c.agent_port
                     FROM warm_pool wp
                     JOIN containers c ON c.id = wp.container_id
                     WHERE wp.function_id IS NULL AND wp.status = 'warm'
                     ORDER BY wp.created_at ASC LIMIT 1
                     FOR UPDATE SKIP LOCKED`,
                    []
                );
                row = result.rows[0] || null;
            }
            if (!row) {
                await client.query('COMMIT');
                return null;
            }

            await client.query(
                `UPDATE warm_pool SET status = 'claimed', claimed_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [row.id]
            );
            await client.query('COMMIT');
            return row;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    },

    async countWarm(functionId) {
        if (functionId) {
            const row = await queryOne(
                "SELECT COUNT(*) as cnt FROM warm_pool WHERE (function_id = $1 OR function_id IS NULL) AND status = 'warm'",
                [functionId]
            );
            return row ? parseInt(row.cnt) : 0;
        }
        const row = await queryOne(
            "SELECT COUNT(*) as cnt FROM warm_pool WHERE status = 'warm'",
            []
        );
        return row ? parseInt(row.cnt) : 0;
    },

    async countAll() {
        const row = await queryOne("SELECT COUNT(*) as cnt FROM warm_pool WHERE status = 'warm'", []);
        return row ? parseInt(row.cnt) : 0;
    },

    async findAll() {
        return queryAll(
            `SELECT wp.*, c.container_name, c.container_ip, c.status as container_status
             FROM warm_pool wp
             JOIN containers c ON c.id = wp.container_id
             ORDER BY wp.created_at DESC`
        );
    },

    async deleteByContainer(containerId) {
        await run('DELETE FROM warm_pool WHERE container_id = $1', [containerId]);
    },

    async findByContainer(containerId) {
        return queryOne('SELECT * FROM warm_pool WHERE container_id = $1', [containerId]);
    },

    async markWarm(containerId) {
        await run(`UPDATE warm_pool SET status = 'warm', claimed_at = NULL WHERE container_id = $1`, [containerId]);
        await run(`UPDATE containers SET status = 'paused' WHERE id = $1`, [containerId]);
    },

    async removeByFunctionId(functionId) {
        await run('DELETE FROM warm_pool WHERE function_id = $1', [functionId]);
    },

    async removeByWorkerId(workerId) {
        await run('DELETE FROM warm_pool WHERE worker_id = $1', [workerId]);
    },
};

// ─── events ───────────────────────────────────────────────────────────────────

const events = {
    async insert(e) {
        const { sql: s, values } = namedToPositional(
            `INSERT INTO worker_events (worker_id, event_type, message)
             VALUES (@worker_id, @event_type, @message)`,
            e
        );
        await run(s, values);
    },

    async findByWorker(workerId) {
        return queryAll(
            'SELECT * FROM worker_events WHERE worker_id = $1 ORDER BY created_at DESC LIMIT 50',
            [workerId]
        );
    },
};

// ─── functions ────────────────────────────────────────────────────────────────

const functions = {
    async insert(f) {
        const { sql: s, values } = namedToPositional(
            `INSERT INTO functions (id, name, image, region, agent_cmd, agent_port, env_vars, memory_limit, cpu_limit, storage_limit, max_containers, warm_count, status, auth_policy)
             VALUES (@id, @name, @image, @region, @agent_cmd, @agent_port, @env_vars, @memory_limit, @cpu_limit, @storage_limit, @max_containers, @warm_count, @status, @auth_policy)`,
            f
        );
        await run(s, values);
    },

    async findAll() {
        return queryAll('SELECT * FROM functions ORDER BY created_at DESC');
    },

    async findById(id) {
        return queryOne('SELECT * FROM functions WHERE id = $1', [id]);
    },

    async findByNameAndRegion(name, region) {
        return queryOne('SELECT * FROM functions WHERE name = $1 AND region = $2', [name, region]);
    },

    async updateStatus(id, status) {
        await run(`UPDATE functions SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [status, id]);
    },

    async update(id, fields) {
        await run(
            `UPDATE functions SET
                image = COALESCE($1, image),
                agent_cmd = COALESCE($2, agent_cmd),
                agent_port = COALESCE($3, agent_port),
                env_vars = COALESCE($4, env_vars),
                memory_limit = COALESCE($5, memory_limit),
                cpu_limit = COALESCE($6, cpu_limit),
                storage_limit = COALESCE($7, storage_limit),
                max_containers = COALESCE($8, max_containers),
                warm_count = COALESCE($9, warm_count),
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $10`,
            [
                fields.image || null,
                fields.agent_cmd || null,
                fields.agent_port || null,
                fields.env_vars || null,
                fields.memory_limit || null,
                fields.cpu_limit || null,
                fields.storage_limit || null,
                fields.max_containers || null,
                fields.warm_count || null,
                id,
            ]
        );
    },

    async delete(id) {
        await run('DELETE FROM functions WHERE id = $1', [id]);
    },

    async deleteById(id) {
        await run('DELETE FROM functions WHERE id = $1', [id]);
    },
};

// ─── api_keys ─────────────────────────────────────────────────────────────────

const apiKeys = {
    async insert(k) {
        const { sql: s, values } = namedToPositional(
            `INSERT INTO api_keys (id, key, function_id, status)
             VALUES (@id, @key, @function_id, @status)`,
            k
        );
        await run(s, values);
    },

    async findByKey(key) {
        return queryOne("SELECT * FROM api_keys WHERE key = $1 AND status = 'active'", [key]);
    },

    async findByFunction(functionId) {
        return queryAll('SELECT * FROM api_keys WHERE function_id = $1', [functionId]);
    },

    async findByKeyAndFunction(key, functionId) {
        return queryOne("SELECT * FROM api_keys WHERE key = $1 AND function_id = $2 AND status = 'active'", [key, functionId]);
    },
};

// ─── invocations ──────────────────────────────────────────────────────────────

const invocations = {
    async insert(inv) {
        const { sql: s, values } = namedToPositional(
            `INSERT INTO invocations (id, function_id, container_id, status_code, latency_ms, request_method, request_path)
             VALUES (@id, @function_id, @container_id, @status_code, @latency_ms, @request_method, @request_path)`,
            inv
        );
        await run(s, values);
    },

    async findByFunction(functionId) {
        return queryAll('SELECT * FROM invocations WHERE function_id = $1 ORDER BY created_at DESC', [functionId]);
    },

    async insertBatch(items) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const item of items) {
                await client.query(
                    `INSERT INTO invocations (id, function_id, container_id, status_code, latency_ms, request_method, request_path)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [
                        item.id,
                        item.function_id,
                        item.container_id || null,
                        item.status_code || 200,
                        item.latency_ms || 0,
                        item.request_method || 'GET',
                        item.request_path || '/'
                    ]
                );
            }
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    },
};

module.exports = { initDb, getDb, queryAll, queryOne, run, workers, containers, warmPool, events, functions, apiKeys, invocations };