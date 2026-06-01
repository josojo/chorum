// GET /api/asker-login/status?requestId=… — poll a "Sign in with Self" login.
//
// Proxies the broker's GET /v1/askers/login/:id/status. While the scan is
// outstanding the broker returns {status:"pending"}; once a verified proof
// lands it returns {status:"complete", eligibility, asker_session}. The browser
// polls this until it leaves "pending".

import { NextResponse } from "next/server";
import { BROKER_URL } from "@/lib/asker-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const requestId = new URL(req.url).searchParams.get("requestId") ?? "";
  if (!requestId) {
    return NextResponse.json({ error: "requestId is required" }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(
      `${BROKER_URL}/v1/askers/login/${encodeURIComponent(requestId)}/status`,
      { method: "GET", cache: "no-store" },
    );
  } catch {
    return NextResponse.json(
      { error: "Couldn't reach the verification service. Try again in a moment." },
      { status: 502 },
    );
  }
  if (res.status === 404) {
    return NextResponse.json({ error: "unknown request" }, { status: 404 });
  }
  if (!res.ok) {
    return NextResponse.json(
      { error: "Verification is unavailable right now. Try again shortly." },
      { status: 502 },
    );
  }
  return NextResponse.json(await res.json(), {
    headers: { "cache-control": "no-store" },
  });
}
