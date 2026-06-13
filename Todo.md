* Region Selection and Backend creating VMs
* Auto Scaling Limits
* Function from :
    *   Blueprint
    *   conatiner image (Github, Docker Hub)

* Extend more languages
* Add Latency, Error/Success Rate in monitoring
* Limit Storage/CPU

* Authentication
O6hxEhdRVhv8uD1BRqzmMYAc8ILeAxBXhGnwul1qkUTCbGsRcsZAR2Je4lBTX9w0UyTQWrLgJn3lxdXBNVr7Cg

EcommerceDrs@123

---

## Nova Kata Gateway — Future Optimizations

### Skip existenceCheck When Container Is Already Cached

**Current flow** (3 cache lookups on hot path):
```
existenceCheck → cache.get("fn:name") → HIT
authCheck → uses functionData.auth_policy
containerStateCheck → cache.get("ct:name") → HIT
```

**Optimized flow** (2 cache lookups):
```
containerStateCheck → cache.get("ct:name") → HIT (includes auth_policy)
authCheck → uses cached auth_policy
```

**How**: Include `auth_policy` and `function_id` in the container cache entry (`ct:` keys). When `containerStateCheck` gets a cache hit, it has everything `authCheck` needs — no separate existence check required.

**Benefit**: Eliminates one cache lookup on the hot path (~0.02ms per request).

**Risk**: `auth_policy` in container cache could become stale if admin changes it. Safety net: the 1-hour `FUNCTION_CACHE_TTL` ensures eventual consistency.

**Priority**: Low — small gain, requires restructuring middleware order and adding more data to container cache entries.

---

## Nova Kata Gateway — Cache Invalidation Edge Cases & Future Work

### Edge Case: Stale node-cache After Redis Crash (Pub/Sub Gap)

**Scenario:**
1. Admin changes function metadata (e.g., auth_policy from "public" to "private")
2. Invalidation request hits Instance A → deletes from Redis + local node-cache
3. Redis crashes immediately after deletion
4. Instance B's `cache.get()` falls back to node-cache → returns stale `{auth_policy: "public"}`
5. Unauthorized requests may be accepted until FUNCTION_CACHE_TTL expires (default: 1 hour)

**Current mitigation:** FUNCTION_CACHE_TTL (1 hour) ensures eventual consistency even if invalidation fails.

**Future fix:** Add Redis Pub/Sub for cross-instance cache invalidation:
- When any instance receives an invalidation request, publish `cache:invalidate` message on Redis
- All instances subscribe and delete their local node-cache entries
- Even if Redis crashes after Pub/Sub delivery, all node-caches are already clean
- Implementation: ~20 lines in `redisClient.js` (subscribe to channel) + emit event in `cache.js`

**Priority:** Medium — only matters with multiple gateway instances + frequent admin changes + Redis instability.
**When to implement:** When deploying with 2+ gateway instances behind a load balancer.

### Future Step: Make FUNCTION_CACHE_TTL Configurable

Already implemented via `FUNCTION_CACHE_TTL` env var (default: 3600s = 1 hour).
Adjust in `.env` or deployment config:
- Development: `FUNCTION_CACHE_TTL=300` (5 min — faster iteration)
- Production: `FUNCTION_CACHE_TTL=3600` (1 hour — fewer DB queries)
