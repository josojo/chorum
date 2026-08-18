import { generateKeyPairSync } from "node:crypto";
import type { ChorumBroker, IdentityCredential, IdentityProvider, Question } from "./types.js";

const jsonHeaders = { "content-type": "application/json" };

function rawEd25519Keypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { seed, publicKey: pub.toString("base64") };
}

export class SelfIdentityProvider implements IdentityProvider {
  private readonly pending = new Map<string, { requestId: string; seed: Buffer; publicKey: string }>();

  constructor(private readonly bridgeUrl: string, private readonly brokerUrl: string) {}

  async begin(_userId: string) {
    const key = rawEd25519Keypair();
    const response = await fetch(`${this.bridgeUrl.replace(/\/$/, "")}/requests`, {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ agentKey: key.publicKey, profile: "minimal" }),
    });
    if (!response.ok) throw new Error("Self authorization could not be started");
    const body = await response.json() as { requestId?: string; urls?: string[] };
    if (!body.requestId || !body.urls?.[0]) throw new Error("Self bridge returned an invalid authorization request");
    this.pending.set(body.requestId, { requestId: body.requestId, seed: key.seed, publicKey: key.publicKey });
    return { state: body.requestId, authorizationUrl: body.urls[0] };
  }

  async complete(_userId: string, state: string): Promise<IdentityCredential> {
    const pending = this.pending.get(state);
    if (!pending) throw new Error("Self authorization request is missing or expired");
    const deadline = Date.now() + 300_000;
    let body: { status?: string; verified?: boolean; bundles?: unknown } = {};
    while (Date.now() < deadline) {
      const response = await fetch(`${this.bridgeUrl.replace(/\/$/, "")}/requests/${encodeURIComponent(state)}`);
      if (!response.ok) throw new Error("Self authorization status could not be read");
      body = await response.json() as typeof body;
      if (body.status === "complete") break;
      if (body.status === "rejected" || body.status === "error") throw new Error("Self authorization was rejected");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (body.status !== "complete" || body.verified !== true || !body.bundles) throw new Error("Self authorization did not complete");
    const registration = await fetch(`${this.brokerUrl.replace(/\/$/, "")}/v1/register`, {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ self_proofs: body.bundles, agent_key: pending.publicKey }),
    });
    if (!registration.ok) throw new Error("Chorum identity registration failed");
    const result = await registration.json() as { accepted?: boolean; delegation_token?: Record<string, unknown> };
    if (result.accepted !== true || !result.delegation_token) throw new Error("Chorum identity registration was rejected");
    this.pending.delete(state);
    const uniqueIdentifier = typeof result.delegation_token.unique_identifier === "string"
      ? result.delegation_token.unique_identifier
      : undefined;
    return {
      delegation_token: result.delegation_token,
      agent_seed_b64: pending.seed.toString("base64"),
      unique_identifier: uniqueIdentifier,
    };
  }
}

export class HttpChorumBroker implements ChorumBroker {
  constructor(private readonly brokerUrl: string) {}

  async latestQuestions(_userId: string): Promise<Question[]> {
    const response = await fetch(`${this.brokerUrl.replace(/\/$/, "")}/v1/questions/open`);
    if (!response.ok) throw new Error("Chorum questions could not be retrieved");
    return await response.json() as Question[];
  }

  async review(_userId: string) {
    return { answers: [] };
  }
}
