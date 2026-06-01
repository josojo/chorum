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
