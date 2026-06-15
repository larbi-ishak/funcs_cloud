import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbFile = process.env.DB_PATH || '../nova-kata/data/nova-kata.db';
const projectRoot = path.resolve(__dirname, '../../');
const DB_PATH = path.resolve(projectRoot, dbFile);

let db;

/**
 * Initialise the read-only database connection.
 * better-sqlite3 opens the file directly — no reloadDb() needed,
 * reads always return the latest data (thanks to WAL mode).
 */
function initDb() {
    if (!fs.existsSync(DB_PATH)) {
        throw new Error(`Database file not found at ${DB_PATH}. Is Nova Kata running?`);
    }

    // Open in read-only mode — the gateway never writes to the database.
    // WAL mode is set by Nova Kata (the writer); the gateway benefits from it automatically.
    db = new Database(DB_PATH, { readonly: true });

    logger.info(`Loaded read-only database from ${DB_PATH}`);
}

/**
 * Query a single row. With better-sqlite3, this always reads the latest
 * data from disk — no reloadDb() needed.
 */
function queryOne(sql, params = []) {
    return db.prepare(sql).get(...params);
}

/**
 * Query multiple rows.
 */
function queryAll(sql, params = []) {
    return db.prepare(sql).all(...params);
}

const functions = {
    findAll() {
        return queryAll('SELECT * FROM functions');
    },
    findByNameAndRegion(name, region) {
        return queryOne('SELECT * FROM functions WHERE name = ? AND region = ?', [name, region]);
    },
    findByName(name) {
        return queryOne('SELECT * FROM functions WHERE name = ?', [name]);
    }
};

const apiKeys = {
    findByKey(key) {
        return queryOne("SELECT * FROM api_keys WHERE key = ? AND status = 'active'", [key]);
    },
    /**
     * Find an active API key that belongs to a specific function.
     * Single atomic check — ensures the key exists AND belongs to the requested function.
     * More secure than findByKey + code check: doesn't leak key data for other functions.
     */
    findByKeyAndFunction(key, functionId) {
        return queryOne("SELECT * FROM api_keys WHERE key = ? AND function_id = ? AND status = 'active'", [key, functionId]);
    }
};

const containers = {
    /**
     * Find a single running container for the given function.
     */
    findRunningByFunction(functionId) {
        return queryOne(
            "SELECT * FROM containers WHERE function_id = ? AND status = 'running' LIMIT 1",
            [functionId]
        );
    },
    /**
     * Find ALL running containers for the given function.
     * Used for round-robin pool routing — distributes traffic across multiple containers.
     */
    findAllRunningByFunction(functionId) {
        return queryAll(
            "SELECT * FROM containers WHERE function_id = ? AND status = 'running'",
            [functionId]
        );
    }
};

export { initDb, functions, apiKeys, containers };