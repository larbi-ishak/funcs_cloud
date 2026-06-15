const Database = require('better-sqlite3');
const db = new Database('./data/nova-kata.db');

// Find warm pool entries referencing workers that no longer exist
const stale = db.prepare(`
    SELECT wp.id, wp.worker_id, wp.container_id
    FROM warm_pool wp
    LEFT JOIN workers w ON wp.worker_id = w.id
    WHERE w.id IS NULL
`).all();

console.log(`Stale warm pool entries (worker no longer exists): ${stale.length}`);

if (stale.length > 0) {
    const del = db.prepare('DELETE FROM warm_pool WHERE worker_id = ?');
    const deadWorkers = new Set(stale.map(s => s.worker_id));
    for (const w of deadWorkers) {
        const result = del.run(w);
        console.log(`Deleted ${result.changes} entries for dead worker ${w}`);
    }
}

// Also clean up containers referencing dead workers
const staleContainers = db.prepare(`
    SELECT c.id, c.worker_id, c.container_name
    FROM containers c
    LEFT JOIN workers w ON c.worker_id = w.id
    WHERE w.id IS NULL AND c.status NOT IN ('stopped', 'failed')
`).all();

console.log(`Stale container entries: ${staleContainers.length}`);

if (staleContainers.length > 0) {
    const update = db.prepare("UPDATE containers SET status = 'failed' WHERE worker_id = ?");
    const deadWorkers = new Set(staleContainers.map(s => s.worker_id));
    for (const w of deadWorkers) {
        const result = update.run(w);
        console.log(`Marked ${result.changes} containers as failed for dead worker ${w}`);
    }
}

console.log('Cleanup done');
db.close();