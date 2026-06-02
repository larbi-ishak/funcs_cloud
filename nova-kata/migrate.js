const fs = require('fs');
const initSqlJs = require('sql.js');

async function migrate() {
    const dbPath = 'c:/Users/l00926210/Documents/Workspace/Placement_Nova/nova-kata/data/nova-kata.db';
    const SQL = await initSqlJs();
    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    try {
        db.run('ALTER TABLE functions ADD COLUMN memory_limit INTEGER DEFAULT 512;');
        console.log('Added memory_limit to functions');
    } catch(e) {
        console.log('memory_limit already exists or error:', e.message);
    }

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
    console.log('Created invocations table');

    fs.writeFileSync(dbPath, Buffer.from(db.export()));
    console.log('Migration complete');
}

migrate().catch(console.error);
