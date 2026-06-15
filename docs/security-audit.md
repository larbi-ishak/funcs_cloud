# Security Audit — Nova Kata

> Generated from codebase review on 2026-06-13
> Updated: 2026-06-15 — Items 1-3 fixed, item 5 removed, Worker API security hardened

---

## ✅ FIXED

### 1. Shell Injection Risk in containerService.js ✅ Done

**Fix applied**: Added image name validation regex in both `containerService.js` and `functions.js` route. Rejects any image name containing shell metacharacters (`;`, `'`, `$`, `|`, `&`, etc.).

```js
const IMAGE_REGEX = /^(?:[a-zA-Z0-9._-]+(?::\d+)?\/)?[a-zA-Z0-9._-]+(?::[a-zA-Z0-9._-]+)?$/;
```

Validated at two levels:
- `POST /functions` route — early rejection with 400 error
- `launchContainer()` — defense-in-depth before bash interpolation

---

### 2. Plaintext Worker Passwords in Database ✅ Done

**Fix applied**: AES-256-GCM encryption at rest. Created `nova-kata/src/utils/crypto.js` with `encrypt()`/`decrypt()` helpers.

- Worker passwords are encrypted on insert (`workerService.js`)
- Passwords are decrypted at SSH connection time (`ssh.js`)
- Legacy plaintext passwords are handled gracefully (decrypt falls back to plaintext)
- Encryption key stored in `ENCRYPTION_KEY` env var (32-byte hex)

---

### 3. Leaked Credentials in Todo.md ✅ Done

**Fix applied**: Removed API key and password from `Todo.md`. Updated security references.

**Remaining**: Credentials are still in git history — rotate them.

---

### 4. Exposed GCP Service Account Key

**File**: `nova-kata/cobalt-nomad.json` (removed from git tracking, still in git history)

**Status**: File removed from git tracking via `git rm --cached`. `.gitignore` updated. Key rotation still required.

---


### 6. SQLite Concurrent Access Between Processes

**Previous concern**: Both `nova-kata` (writer) and `nova-kata-gateway` (reader) access the same SQLite file, risking locking errors.

**Fix applied**: Migrated from `sql.js` (WASM, in-memory) to `better-sqlite3` (native C++):
- Nova Kata opens DB in read-write mode with `journal_mode = WAL`
- Gateway opens DB in `readonly: true` mode
- WAL mode allows concurrent reads while the writer is writing — no locking errors

---

### 7. Worker API Security Hardening ✅ Done

**Fixes applied:**

- **Timing-safe API key comparison** — Uses `crypto.timingSafeEqual()` instead of `!==` to prevent timing attacks on the API key
- **Request size limiting** — `express.json({ limit: '10mb' })` prevents OOM from oversized payloads
- **Path traversal protection** — `isSafePath()` rejects paths containing `..` (e.g., `/opt/nova/../../etc/passwd`)
- **Container name validation** — `CONTAINER_NAME_REGEX` rejects shell metacharacters in container names
- **Default key warning** — Logs warning if `WORKER_API_KEY` is not set in production

---

## Future Security Enhancements

These are not required at current scale but should be implemented before multi-tenant or public deployment:

| Priority | Enhancement | Effort | Risk Mitigated |
|---|---|---|---|
| 1 | **Command allowlist for `/exec`** | ~30min | If API key is compromised, attacker can run any command. Allowlist restricts to known safe commands (mkdir, rm, nerdctl push, etc.) |
| 2 | **Rate limiting** | ~30min | No protection against brute-force API key guessing or DoS. Simple in-memory rate limiter per IP. |
| 3 | **TLS for Worker API** | ~1hr | API key transmitted in plaintext on internal network. Self-signed cert on worker + HTTPS. |
| 4 | **GCP service account key rotation** | Manual | Key removed from git tracking but still in git history. Generate new key, update GCP. |
| 5 | **Request signing (HMAC)** | ~2hr | API key in header could be replayed. HMAC signing with timestamp prevents replay attacks. |
| 6 | **IP allowlist** | ~15min | Restrict Worker API to only accept requests from known placement service IPs. |

---

## Architecture Notes

### Gateway → Placement → Worker SSH Hop

The gateway calls back to the placement service (Nova Kata on :3002) to claim warm containers. This means every cold start adds an extra HTTP hop:

```
Client → Gateway → Placement Service → Worker SSH → Container
```

This is a clean separation of concerns — the gateway only routes, never manages containers. The extra latency (~50-100ms) only affects cold starts, which are already slow. Hot requests skip this entirely (cache hit → direct proxy to container).

The keep-alive `axios` client and persistent `http.Agent` added to `containerStateCheck.js` mitigate TCP overhead on repeated calls.