/**
 * Dashboard Authentication Middleware.
 *
 * Simple shared-secret auth via DASHBOARD_AUTH_KEY env var.
 * If the env var is not set, auth is disabled (for local dev).
 *
 * Checks for:
 * - `X-Dashboard-Key` header (API calls)
 * - `dashboard_key` cookie (browser requests)
 *
 * PostgreSQL-ready: Independent of DB driver. Can upgrade to
 * session-based auth when PG migration happens.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const AUTH_KEY = process.env.DASHBOARD_AUTH_KEY;

export function middleware(request: NextRequest) {
    // Auth disabled if no key configured (local dev)
    if (!AUTH_KEY) return NextResponse.next();

    // Skip auth for static assets and _next
    if (request.nextUrl.pathname.startsWith("/_next") ||
        request.nextUrl.pathname.startsWith("/static")) {
        return NextResponse.next();
    }

    // Check header or cookie
    const headerKey = request.headers.get("x-dashboard-key");
    const cookieKey = request.cookies.get("dashboard_key")?.value;

    if (headerKey === AUTH_KEY || cookieKey === AUTH_KEY) {
        return NextResponse.next();
    }

    // Redirect to login for browser requests, 401 for API
    const accept = request.headers.get("accept") || "";
    if (accept.includes("text/html")) {
        return NextResponse.redirect(new URL("/login", request.url));
    }

    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export const config = {
    matcher: ["/((?!login|api/auth).*)"],
};