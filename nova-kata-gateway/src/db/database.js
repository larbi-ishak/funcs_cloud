import pg from 'pg';
import logger from '../utils/logger.js';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://nova_kata:nova_kata_secret@localhost:5432/nova_kata';

let pool;

/**
 * Initialise the read-only PostgreSQL connection pool.
 * The gateway never writes to the database — only reads for routing/auth.
 */
async function initDb() {
    pool = new Pool({ connectionString: DATABASE_URL, max: 10 });

    // Test connection
    const client = await pool.connect();
    try {
        await client.query('SELECT 1');
        logger.info(`PostgreSQL connected (read-only): ${DATABASE_URL.replace(/:[^:@]+@/, ':****@')}`);
    } finally {
        client.release();
    }
}

/**
 * Query a single row.
 */
async function queryOne(sql, params = []) {
    const result = await pool.query(sql, params);
    return result.rows[0] || null;
}

/**
 * Query multiple rows.
 */
async function queryAll(sql, params = []) {
    const result = await pool.query(sql, params);
    return result.rows;
}

const functions = {
    async findAll() {
        return queryAll('SELECT * FROM functions');
    },
    async findByNameAndRegion(name, region) {
        return queryOne('SELECT * FROM functions WHERE name = $1 AND region = $2', [name, region]);
    },
    async findByName(name) {
        return queryOne('SELECT * FROM functions WHERE name = $1', [name]);
    }
};

const apiKeys = {
    async findByKey(key) {
        return queryOne("SELECT * FROM api_keys WHERE key = $1 AND status = 'active'", [key]);
    },
    /**
     * Find an active API key that belongs to a specific function.
     * Single atomic check — ensures the key exists AND belongs to the requested function.
     */
    async findByKeyAndFunction(key, functionId) {
        return queryOne("SELECT * FROM api_keys WHERE key = $1 AND function_id = $2 AND status = 'active'", [key, functionId]);
    }
};

const containers = {
    /**
     * Find a single running container for the given function.
     */
    async findRunningByFunction(functionId) {
        return queryOne(
            "SELECT * FROM containers WHERE function_id = $1 AND status = 'running' LIMIT 1",
            [functionId]
        );
    },
    /**
     * Find ALL running containers for the given function.
     * Used for round-robin pool routing — distributes traffic across multiple containers.
     */
    async findAllRunningByFunction(functionId) {
        return queryAll(
            "SELECT * FROM containers WHERE function_id = $1 AND status = 'running'",
            [functionId]
        );
    }
};

export { initDb, functions, apiKeys, containers };