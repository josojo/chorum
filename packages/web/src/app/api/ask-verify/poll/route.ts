// GET /api/ask-verify/poll?id=<requestId> — poll a web verification.
//
// Proxies to the self-bridge (server-side). When the proof is in AND verified,
// the broker-grade check has already happened in the bridge (real SNARK +
// on-chain root check), so we mint the asker session cookie here and report
// success. The cookie is the only thing that unlocks posting a question.

import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { pollRequest } from "@/lib/self-bridge";
import { SESSION_COOKIE, SESSION_MAX_AGE, sign } from "@/lib/self-session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  let result;
  try {
    result = await pollRequest(id);
  } catch {
    return NextResponse.json({ error: "verification poll failed" }, { status: 502 });
  }

  if (result.status === "complete" && result.verified && result.uniqueIdentifier) {
    cookies().set(SESSION_COOKIE, sign(result.uniqueIdentifier), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE,
    });
    return NextResponse.json({ verified: true });
  }

  // Proof landed but did not verify — let the client prompt a re-scan.
  if (result.status === "complete" && !result.verified) {
    return NextResponse.json({ verified: false, failed: true });
  }

  return NextResponse.json({ verified: false });
}
