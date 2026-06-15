# Dashboard Improvements — Nova Dashboard

> **Status:** Items 2, 3, 6, 7, 9, 11, 12, 13, 14 done. Remaining items documented below.
> **Created:** 2026-06-14

---

## ✅ Completed

### 2. Environment Variables for API URLs ✅ Done

Replaced all hardcoded `localhost:3002` URLs with `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_GATEWAY_URL`, and `NEXT_PUBLIC_METRICS_URL` env vars. Created `.env.local` with defaults.

### 3. Input Validation on Forms ✅ Done

Added `FN_NAME_REGEX` validation on deploy form with real-time red border + helper text. Added `IMAGE_REGEX` constant matching backend validation. Added JSON validation for env vars (already existed).

### 6. Remove Dead Dependencies ✅ Done

Removed `date-fns` (unused). Kept `recharts` for future chart use. Deleted 5 unused SVGs from `public/`.

### 7. Loading States ✅ Done

Added `loading.tsx` for root, `/workers`, and `/metrics` routes with skeleton/spinner components.

### 9. Error Boundaries ✅ Done

Added `error.tsx` at root level with "Something went wrong" UI + retry button.

### 11. Dark Mode Toggle ✅ Done

Added `ThemeToggle` component in header. Toggles `dark` class on `<html>`, persists preference in `localStorage`.

### 12. Metrics Page ✅ Done

Created `/metrics` page that fetches Prometheus metrics from gateway's `/metrics` endpoint (port 3003). Displays:
- Key metric cards (avg latency, total requests, cache hits, rate limited)
- Process metrics (uptime, memory, heap usage)
- Latency distribution histogram
- Warm pool size gauge
- Collapsible raw Prometheus output

Auto-refreshes every 10s.

### 13. Confirmation Dialogs ✅ Done

Added `confirm()` dialogs before deleting functions and removing workers with descriptive messages.

### 14. Image Name Validation ✅ Done

Added `FN_NAME_REGEX` client-side validation on deploy form with real-time feedback (red border + helper text).

---

## 📋 Remaining Items (Documented)

### 1. Dashboard Authentication

**Problem:** Anyone who can reach the dashboard URL has full admin access.

**Plan:** Add Next.js `middleware.ts` that checks for a session cookie or API key. Even a simple shared secret (env var `DASHBOARD_AUTH_KEY`) is better than nothing. Long-term: integrate with the placement service's API key system.

**Effort:** ~2 hours

---

### 4. Data Caching with SWR/React Query

**Problem:** Every page does `fetch()` in `useEffect` with no caching. Navigating away and back triggers a full re-fetch. No stale-while-revalidate, no background refresh.

**Plan:** Install `swr` package. Replace all `fetch()` + `useEffect` + `useState` patterns with `useSWR()`:
```tsx
const { data, error } = useSWR(`${API_URL}/functions`, fetcher, { refreshInterval: 5000 });
```

**Effort:** ~2 hours

---

### 5. Real-Time Updates via SSE

**Problem:** Dashboard polls every 5s. Worker health, container status, and warm pool size change more frequently.

**Plan:** The deploy page already uses SSE — extend to other pages. Or use SWR's `refreshInterval` for simpler polling.

**Effort:** ~1 hour

---

### 8. Shared Component Library

**Problem:** Every page has inline card, badge, button, and table styles. No reusable components.

**Plan:** Create `src/components/` with:
- `StatusBadge` (healthy/faulty/paused/running)
- `MetricCard` (the stat cards)
- `DataTable` (reusable table)
- `PageHeader` (consistent page titles)
- `ConfirmDialog` (replaces `confirm()`)

**Effort:** ~3 hours

---

### 10. Proper TypeScript Types

**Problem:** API responses are typed as `any`. No Zod/schema validation.

**Plan:** Define interfaces for all API responses:
```tsx
interface Function { id: string; name: string; image: string; status: string; ... }
interface Worker { id: string; ip: string; status: string; ... }
```
Add Zod validation at API boundary.

**Effort:** ~2 hours

---

### 15. Next.js API Proxy Routes (BFF)

**Problem:** Browser makes direct calls to the placement service, exposing the backend URL and preventing server-side auth.

**Plan:** Add Next.js API routes as a proxy:
```
Browser → Next.js /api/* → Placement Service
         (adds auth headers, hides backend URL)
```

**Effort:** ~2 hours

---

### 16. No Tests

**Problem:** Zero test coverage.

**Plan:** Add Playwright for E2E tests + Vitest for unit tests.

**Effort:** ~4 hours

---

### 17. Polling Anti-Pattern → SWR/React Query

**Problem:** All pages use raw `setInterval` + `fetch` in `useEffect`. This causes:
- **Network spam:** 3 browser tabs = 3x requests every 5s (client-side DDoS)
- **Render thrashing:** Every 5s, `setFunctions(data)` receives a new array reference from `JSON.parse`, triggering full DOM reconciliation even if data hasn't changed
- **No deduplication:** Multiple components fetching the same URL make separate requests

**Plan:** Install `swr`. Replace all `fetch()` + `useEffect` + `setInterval` patterns with `useSWR()`:
```tsx
const { data, error } = useSWR(`${API_URL}/functions`, fetcher, { refreshInterval: 5000 });
```
SWR handles: request deduplication, stale-while-revalidate, focus revalidation, and shallow comparison to prevent unnecessary re-renders.

**Effort:** ~2 hours

---

### 18. Zombie SSE Stream (AbortController Leak)

**Problem:** In `deploy/page.tsx`, the `handleDeploy` function starts an SSE stream with a `while(true)` loop. If the user navigates away during deployment, the component unmounts but the fetch promise continues running — processing chunks into a `setLogs` setter for a component that no longer exists. This causes React memory leak warnings and wastes resources.

**Plan:** Bind the deployment fetch to an `AbortController` and abort on unmount:
```tsx
const abortRef = useRef<AbortController | null>(null);

// In handleDeploy:
abortRef.current = new AbortController();
const response = await fetch(url, { signal: abortRef.current.signal, ... });

// In useEffect cleanup:
useEffect(() => {
  return () => abortRef.current?.abort();
}, []);
```

**Effort:** ~30 minutes

---

### 19. Unbounded File Upload (Browser Crash)

**Problem:** The deploy form allows directory upload via `<input webkitdirectory>`. While it filters `node_modules` and `__pycache__`, selecting a Python `venv/` folder with 15,000 files will:
1. Load 15,000 `File` objects into React state synchronously
2. Parse all 15,000 paths into the file tree
3. Render 15,000 `FileTreeNode` DOM elements
4. Freeze/crash the browser tab

**Plan:**
1. **Hard limit:** Enforce max 500 files and max 50MB total size before setting state
2. **Truncate display:** Show first 50 files in the tree with a "+N more files" message
3. **Future:** Use `@tanstack/react-virtual` for virtualized rendering if large trees are needed

```tsx
if (selected.length > 500) return alert("Too many files. Limit is 500.");
const totalSize = selected.reduce((sum, f) => sum + f.size, 0);
if (totalSize > 50 * 1024 * 1024) return alert("Total size exceeds 50MB limit.");
```

**Effort:** ~30 minutes

---

### 20. Replace `alert()` with Toast Notifications

**Problem:** Error handling uses `alert()` — a blocking browser API that:
- Stops all JavaScript execution (including SSE streams and rendering)
- Freezes the UI until the user clicks OK
- Looks terrible in a modern dark-mode dashboard

**Plan:** Install `sonner` (lightweight toast library for React):
```tsx
import { toast } from 'sonner';
// Replace: alert("Failed to delete") → toast.error("Failed to delete")
// Replace: alert("Replenishment triggered") → toast.success("Replenishment triggered")
```
Add `<Toaster />` to the root layout.

**Effort:** ~1 hour

---

## Summary

| # | Issue | Severity | Effort | Status |
|---|---|---|---|---|
| 1 | Dashboard authentication | 🔴 Critical | ~2h | Planned |
| 2 | Env variables for API URLs | 🟡 Medium | ~1h | ✅ Done |
| 3 | Input validation | 🟡 Medium | ~30min | ✅ Done |
| 4 | Data caching (SWR) | 🟡 Medium | ~2h | Planned |
| 5 | Real-time updates (SSE) | 🟢 Low | ~1h | Planned |
| 6 | Dead dependencies | 🟢 Low | ~5min | ✅ Done |
| 7 | Loading states | 🟢 Low | ~1h | ✅ Done |
| 8 | Shared components | 🟢 Low | ~3h | Planned |
| 9 | Error boundaries | 🟢 Low | ~30min | ✅ Done |
| 10 | TypeScript types | 🟢 Low | ~2h | Planned |
| 11 | Dark mode toggle | 🟢 Low | ~30min | ✅ Done |
| 12 | Metrics page | 🟢 Low | ~3h | ✅ Done |
| 13 | Confirmation dialogs | 🟢 Low | ~1h | ✅ Done |
| 14 | Image name validation | 🟢 Low | ~15min | ✅ Done |
| 15 | API proxy routes (BFF) | 🟡 Medium | ~2h | Planned |
| 16 | No tests | 🟢 Low | ~4h | Planned |
| 17 | Polling → SWR/React Query | 🟡 Medium | ~2h | Planned |
| 18 | AbortController for SSE | 🟡 Medium | ~30min | Planned |
| 19 | File upload limits | 🟡 Medium | ~30min | Planned |
| 20 | Toast notifications | 🟢 Low | ~1h | Planned |
