// HTTP client for the self-bridge POST /verify endpoint.
//
// The bridge (packages/self-bridge) is the only component that can run
// @selfxyz/core's SelfBackendVerifier (Node-only) and the one-time on-chain Celo
// registry/root check. The broker delegates the cryptographic proof check to it
// ONCE, at registration (verify/selfIdentity.ts); the binding checks and
// predicate derivation stay here. The broker MUST point at a bridge it controls.

export class BridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

export interface BridgeVerifyResult {
  verified: boolean;
  uniqueIdentifier: string | null;
  // Verified disclosures for this single proof, e.g. {"nationality":"DE","older_than":25}.
  disclosed: Record<string, unknown>;
  boundAgentKey: string | null;
  // On-chain confirmation that the proof's Merkle root is live in Self's Celo
  // Identity Registry. False when no Celo RPC is configured.
  registryConfirmed: boolean;
}

export interface VerifySelfProofArgs {
  bridgeUrl: string;
  attestationId: number;
  proof: unknown;
  publicSignals: unknown[];
  userContextData: string;
  timeout?: number; // seconds
}

export type VerifySelfProof = (args: VerifySelfProofArgs) => Promise<BridgeVerifyResult>;

// ----- asker "Sign in with Self" (login) ----------------------------------
//
// Unlike /verify (one already-collected proof), these drive the bridge's
// request/callback/poll loop so the broker can offer a browser login QR. The
// bridge is the only component that talks to the Self app; the broker proxies
// it so the browser never learns a nullifier it could spoof. See
// routes/askers.ts and packages/self-bridge/src/server.js.

export interface CreateSelfRequestArgs {
  bridgeUrl: string;
  // Ed25519-pubkey-shaped string the bridge commits into the proof as
  // userDefinedData. For an asker login it is an ephemeral throwaway (the
  // nullifier is independent of it), discarded after the scan.
  agentKey: string;
  profile?: "minimal" | "standard";
  timeout?: number; // seconds
}

export interface CreateSelfRequestResult {
  requestId: string;
  urls: string[];
}

export type CreateSelfRequest = (
  args: CreateSelfRequestArgs,
) => Promise<CreateSelfRequestResult>;

export interface GetSelfRequestArgs {
  bridgeUrl: string;
  requestId: string;
  timeout?: number; // seconds
}

// Mirrors the bridge's GET /requests/:id. `found:false` ⇔ the bridge 404'd
// (unknown/expired requestId). When complete, the verified identity is filled.
export interface GetSelfRequestResult {
  found: boolean;
  status: "pending" | "complete";
  verified: boolean;
  uniqueIdentifier: string | null;
  registryConfirmed: boolean;
}

export type GetSelfRequest = (
  args: GetSelfRequestArgs,
) => Promise<GetSelfRequestResult>;

async function bridgeFetch(
  url: string,
  init: RequestInit,
  timeout: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (exc) {
    throw new BridgeError(`bridge request to ${url} failed: ${exc}`);
  } finally {
    clearTimeout(timer);
  }
}

// Ask the bridge to mint a Self request; returns the QR/universal-link urls.
export const createSelfRequest: CreateSelfRequest = async ({
  bridgeUrl,
  agentKey,
  profile = "minimal",
  timeout = 30.0,
}) => {
  const url = `${bridgeUrl.replace(/\/+$/, "")}/requests`;
  const resp = await bridgeFetch(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentKey, profile }),
    },
    timeout,
  );
  if (resp.status !== 200) {
    const text = await resp.text().catch(() => "");
    throw new BridgeError(`bridge POST /requests HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  let data: { requestId?: unknown; urls?: unknown };
  try {
    data = (await resp.json()) as { requestId?: unknown; urls?: unknown };
  } catch (exc) {
    throw new BridgeError(`bridge POST /requests non-JSON body: ${exc}`);
  }
  const requestId = typeof data.requestId === "string" ? data.requestId : "";
  const urls = Array.isArray(data.urls) ? data.urls.filter((u): u is string => typeof u === "string") : [];
  if (!requestId || urls.length === 0) {
    throw new BridgeError("bridge POST /requests returned no requestId/urls");
  }
  return { requestId, urls };
};

// Poll a Self request. 404 ⇒ found:false (never minted / bridge restarted).
export const getSelfRequest: GetSelfRequest = async ({
  bridgeUrl,
  requestId,
  timeout = 30.0,
}) => {
  const url = `${bridgeUrl.replace(/\/+$/, "")}/requests/${encodeURIComponent(requestId)}`;
  const resp = await bridgeFetch(url, { method: "GET" }, timeout);
  if (resp.status === 404) {
    return { found: false, status: "pending", verified: false, uniqueIdentifier: null, registryConfirmed: false };
  }
  if (resp.status !== 200) {
    const text = await resp.text().catch(() => "");
    throw new BridgeError(`bridge GET /requests/:id HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  let data: Record<string, unknown>;
  try {
    data = (await resp.json()) as Record<string, unknown>;
  } catch (exc) {
    throw new BridgeError(`bridge GET /requests/:id non-JSON body: ${exc}`);
  }
  const complete = data.status === "complete";
  return {
    found: true,
    status: complete ? "complete" : "pending",
    verified: Boolean(data.verified),
    uniqueIdentifier: (data.uniqueIdentifier as string | null) ?? null,
    registryConfirmed: Boolean(data.registryConfirmed),
  };
};

// Call the bridge to verify one Self proof bundle. Throws BridgeError on
// transport/protocol failures (distinct from a clean verified=false).
export const verifySelfProof: VerifySelfProof = async ({
  bridgeUrl,
  attestationId,
  proof,
  publicSignals,
  userContextData,
  timeout = 30.0,
}) => {
  const payload = { attestationId, proof, publicSignals, userContextData };
  const url = `${bridgeUrl.replace(/\/+$/, "")}/verify`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (exc) {
    throw new BridgeError(`bridge request to ${url} failed: ${exc}`);
  } finally {
    clearTimeout(timer);
  }

  if (resp.status !== 200) {
    const text = await resp.text().catch(() => "");
    throw new BridgeError(`bridge returned HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  let data: Record<string, unknown>;
  try {
    data = (await resp.json()) as Record<string, unknown>;
  } catch (exc) {
    throw new BridgeError(`bridge returned non-JSON body: ${exc}`);
  }

  const disclosed = data.disclosed;
  return {
    verified: Boolean(data.verified),
    uniqueIdentifier: (data.uniqueIdentifier as string | null) ?? null,
    disclosed: disclosed && typeof disclosed === "object" ? (disclosed as Record<string, unknown>) : {},
    boundAgentKey: (data.boundAgentKey as string | null) ?? null,
    registryConfirmed: Boolean(data.registryConfirmed),
  };
};
