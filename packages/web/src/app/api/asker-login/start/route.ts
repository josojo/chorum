// POST /api/asker-login/start — browser entry point for "Sign in with Self".
//
// Thin server-side proxy to the broker's POST /v1/askers/login/start. The broker
// (which controls the self-bridge) mints a Self request and returns the QR urls;
// the browser renders one as a QR and polls /api/asker-login/status. BROKER_URL
// is server-only, so the browser never talks to the broker or bridge directly.

import { NextResponse } from "next/server";
import { BROKER_URL } from "@/lib/asker-auth";

export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  let res: Response;
  try {
    res = await fetch(`${BROKER_URL}/v1/askers/login/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "minimal" }),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(
      { error: "Couldn't reach the verification service. Try again in a moment." },
      { status: 502 },
    );
  }
  if (!res.ok) {
    return NextResponse.json(
      { error: "Verification is unavailable right now. Try again shortly." },
      { status: 502 },
    );
  }
  const body = (await res.json()) as { request_id: string; qr_urls: string[] };
  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
}
