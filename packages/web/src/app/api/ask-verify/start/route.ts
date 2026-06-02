// POST /api/ask-verify/start — begin a web Self verification.
//
// Proxies to the self-bridge's keyless /web/requests (server-to-server, internal
// network) and returns the QR universal link + the requestId the client polls.

import { NextResponse } from "next/server";
import { startWebRequest } from "@/lib/self-bridge";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const { requestId, url } = await startWebRequest();
    return NextResponse.json({ requestId, url });
  } catch {
    return NextResponse.json(
      { error: "Could not start verification. Try again." },
      { status: 502 },
    );
  }
}
