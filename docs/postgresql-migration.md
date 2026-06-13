# PostgreSQL Migration Plan (Future)

> **Status:** Planned — not yet implemented.  
> **Current DB:** `better-sqlite3` (native SQLite, WAL mode)  
> **When to migrate:** When scaling beyond 1 VM, or when needing managed database, replication, or advanced monitoring.

---

## Why Migrate to PostgreSQL?

| Factor | better-sqlite3 (current) | PostgreSQL |
|---|---|---|
| Multi-VM scaling | ❌ File can't be shared across VMs | ✅ Network access from any VM |
| Data safety | ⚠️ File corruption possible on disk full | ✅ ACID compliant, WAL, crash recovery |
| Backups | ❌ Copy file (may be inconsistent) | ✅ `pg_dump`, streaming replication, point-in-time recovery |
| Monitoring | ❌ None | ✅ `pg_stat_activity`, `pg_stat_statements` |
| Concurrent writes | ⚠️ WAL helps but limited | ✅ MVCC — true concurrent read/write |
| Managed service | ❌ Not available | ✅ AWS RDS, GCP Cloud SQL, Supabase |
| Connection pooling | ❌ N/A (in-process) | ✅ `pg-pool` built into `pg` driver |

---

## Required Changes

### 1. Schema Rewrite (`nova-kata/src/db/schema.sql`)

| SQLite | PostgreSQL |
|---|---|
| `TEXT PRIMARY KEY` | `UUID PRIMARY KEY DEFAULT gen_random_uuid()` |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `SERIAL` or `BIGSERIAL` |
| `datetime('now')` | `NOW()` or `CURRENT_TIMESTAMP` |
| `PRAGMA foreign_keys = ON` | Remove (always enforced) |
| `?` placeholders | `$1, $2, $3` positional params |

### 2. Database Driver (`nova-kata/src/db/database.js` + `nova-kata-gateway/src/db/database.js`)

- Replace `better-sqlite3` with `pg` (pure JS, no native compilation)
- All query functions become `async`
- Remove `persist()` and `reloadDb()` (not needed)
- Add `DATABASE_URL` environment variable

```js
// Before (better-sqlite3 — synchronous):
const db = new Database(DB_PATH);
function queryOne(sql, params = []) {
    return db.prepare(sql).get(...params);
}

// After (pg — async):
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function queryOne(sql, params = []) {
    const result = await pool.query(sql, params);
    return result.rows[0] || null;
}
```

### 3. Cascading Async Changes

Since all DB calls become async, every caller needs `await`:

**Nova Kata:**
- `src/routes/*.js` — all route handlers need `async` + `await` on DB calls
- `src/services/*.js` — all service functions need `async` + `await` on DB calls
- `src/db/database.js` — all CRUD methods become `async`

**Nova Kata Gateway:**
- `src/middleware/existenceCheck.js` — already async ✅
- `src/middleware/authCheck.js` — `apiKeys.findByKey()` needs `await`
- `src/middleware/containerStateCheck.js` — already async ✅, `containers.findRunningByFunction()` needs `await`
- `src/db/database.js` — all query methods become `async`

### 4. Parameter Syntax Change

Every query changes from `?` to `$1, $2, ...`:

```sql
-- Before:
SELECT * FROM functions WHERE name = ? AND region = ?

-- After:
SELECT * FROM functions WHERE name = $1 AND region = $2
```

### 5. Environment Configuration

```env
# .env
DATABASE_URL=postgresql://nova_kata:password@localhost:5432/nova_kata
```

### 6. Local Dev Setup

```bash
# Docker
docker run -d -p 5432:5432 -e POSTGRES_DB=nova_kata -e POSTGRES_USER=nova_kata -e POSTGRES_PASSWORD=password postgres:16-alpine

# Or install directly on VM
sudo apt install postgresql postgresql-contrib
```

### 7. Docker Changes

- Add PostgreSQL service to `docker-compose.yml`
- Remove SQLite file volume (no longer needed)
- Add `DATABASE_URL` environment variable

---

## Migration Phases

1. **Phase 1:** Rewrite `schema.sql` for PostgreSQL syntax
2. **Phase 2:** Rewrite `database.js` in both projects with `pg` driver
3. **Phase 3:** Update all callers to `await` DB calls
4. **Phase 4:** Test locally with Docker PostgreSQL
5. **Phase 5:** Migrate data from SQLite → PostgreSQL (use `pgloader` or custom script)
6. **Phase 6:** Deploy with PostgreSQL on the VM (or managed service)

---

## Cons / Risks

- **Significant code changes** — every DB call → async, every `?` → `$1`
- **Infrastructure dependency** — PostgreSQL must be running for the app to work
- **Higher memory usage** — PostgreSQL process uses ~50-100MB baseline
- **More complex Docker setup** — need PostgreSQL container + health checks
- **Schema testing** — all migrations need re-testing against PostgreSQL