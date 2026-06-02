// GET /api/healthz — static liveness probe for the web container.
//
// Deliberately dependency-free: it does NOT touch Postgres or the broker, so a
// 200 means "Next.js is up and serving", nothing more. That is exactly what the
// compose healthcheck and the deploy health gate (scripts/healthgate.sh) want —
// a signal that the new container booted, not a system-wide readiness check.
// (DB/broker reachability is covered by the broker's own /healthz and by the
// end-to-end checks in docs/DEPLOYMENT.md §6.)

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json(
    { status: "ok" },
    { headers: { "cache-control": "no-store" } },
  );
}
