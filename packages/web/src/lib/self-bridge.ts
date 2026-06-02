// Server-only client for the self-bridge (the Node sidecar that creates +
// verifies Self proofs). The browser never talks to the bridge directly — these
// helpers run inside the web server's API routes and reach the bridge over the
// internal compose network, the same way the broker does.

const BRIDGE_URL = (process.env.SELF_BRIDGE_URL || "http://localhost:8787").replace(/\/+$/, "");

export type WebRequest = { requestId: string; url: string };

/** Mint a keyless web verification request; returns the QR universal link. */
export async function startWebRequest(): Promise<WebRequest> {
  const res = await fetch(`${BRIDGE_URL}/web/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`self-bridge /web/requests ${res.status}`);
  const data = (await res.json()) as Partial<WebRequest>;
  if (!data?.requestId || !data?.url) {
    throw new Error("self-bridge /web/requests returned no requestId/url");
  }
  return { requestId: data.requestId, url: data.url };
}

export type PollResult = {
  status: "pending" | "complete";
  verified?: boolean;
  uniqueIdentifier?: string | null;
};

/** Poll a request's status. A 404 (e.g. bridge restart) reads as still pending. */
export async function pollRequest(requestId: string): Promise<PollResult> {
  const res = await fetch(`${BRIDGE_URL}/requests/${encodeURIComponent(requestId)}`, {
    cache: "no-store",
  });
  if (res.status === 404) return { status: "pending" };
  if (!res.ok) throw new Error(`self-bridge /requests/:id ${res.status}`);
  return (await res.json()) as PollResult;
}
