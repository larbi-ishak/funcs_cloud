# Security Audit — Nova Kata

> Generated from codebase review on 2026-06-13
> Updated: 2026-06-16 — Trimmed to resolved items only. Future work moved to thesis-codebase-context.md.

---

## ✅ FIXED

### 1. Shell Injection Risk in containerService.js ✅ Done

**Fix applied**: Added image name validation regex in both `containerService.js` and `functions.js` route. Rejects any image name containing shell metacharacters (`;`, `'`, `$`, `|`, `&`, etc.).

```js
const IMAGE_REGEX = /^(?:[a-zA-Z0-9._-]+(?::\d+)?\/)?[a-zA-Z0-9._-]+(?::[a-zA-Z0-9._-]+)?$/;
```

---

### 2. Plaintext Worker Passwords in Database ✅ Done

**Fix applied**: AES-256-GCM encryption at rest. Created `nova-kata/src/utils/crypto.js` with `encrypt()`/`decrypt()` helpers. Legacy plaintext passwords handled gracefully (decrypt falls back to plaintext).

---

### 3. Leaked Credentials in Todo.md ✅ Done

**Fix applied**: Removed API key and password from `Todo.md`. Credentials still in git history — rotate if needed.

---

### 4. Exposed GCP Service Account Key

**File**: `nova-kata/cobalt-nomad.json` (removed from git tracking, still in git history)

**Status**: File removed from git tracking via `git rm --cached`. `.gitignore` updated. Key rotation still required.

---

### 6. SQLite Concurrent Access Between Processes ✅ Done

**Fix applied**: Migrated from `sql.js` (WASM, in-memory) to `better-sqlite3` (native C++) with WAL mode. Then migrated to PostgreSQL 16.

---

### 7. Worker API Security Hardening ✅ Done

**Fixes applied:**
- **Timing-safe API key comparison** — `crypto.timingSafeEqual()` instead of `!==`
- **Request size limiting** — `express.json({ limit: '10mb' })`
- **Path traversal protection** — `isSafePath()` rejects `..`
- **Container name validation** — `CONTAINER_NAME_REGEX` rejects shell metacharacters
- **Default key warning** — Logs warning if `WORKER_API_KEY` not set in production

---

## Architecture Notes

### Gateway → Placement → Worker SSH Hop

The gateway calls back to the placement service (Nova Kata on :3002) to claim warm containers. This is a clean separation of concerns — the gateway only routes, never manages containers. The extra latency (~50-100ms) only affects cold starts. Hot requests skip this entirely (cache hit → direct proxy to container).

The keep-alive `axios` client and persistent `http.Agent` added to `containerStateCheck.js` mitigate TCP overhead on repeated calls.