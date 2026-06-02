import initSqlJs from 'sql.js';
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
let SQL;

async function initDb() {
    SQL = await initSqlJs();
    if (!fs.existsSync(DB_PATH)) {
        throw new Error(`Database file not found at ${DB_PATH}. Is Nova Kata running?`);
    }

    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    logger.info(`Loaded read-only database from ${DB_PATH}`);
}

function reloadDb() {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
}

function queryAll(sql, params = []) {
    reloadDb();
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
    reloadDb();
    const stmt = db.prepare(sql);
    stmt.bind(params);
    let row = null;
    if (stmt.step()) {
        row = stmt.getAsObject();
    }
    stmt.free();
    return row;
}

const functions = {
    findByNameAndRegion(name, region) {
        return queryOne('SELECT * FROM functions WHERE name = ? AND region = ?', [name, region]);
    },
    findByName(name) {
        return queryOne('SELECT * FROM functions WHERE name = ?', [name]);
    }
};

const apiKeys = {
    findByKey(key) {
        return queryOne('SELECT * FROM api_keys WHERE key = ? AND status = "active"', [key]);
    }
};

const containers = {
    /**
     * Find a running container for the given function.
     */
    findRunningByFunction(functionId) {
        return queryOne(
            'SELECT * FROM containers WHERE function_id = ? AND status = "running" LIMIT 1',
            [functionId]
        );
    }
};

export { initDb, functions, apiKeys, containers };
