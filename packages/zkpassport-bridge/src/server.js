// hearme zkpassport-bridge — the only place real zkPassport (Noir/UltraHonk)
// proofs are created and verified. The Python broker and skill talk to it over
// HTTP because @zkpassport/sdk (and its @aztec/bb.js verifier) is Node-only.
//
// Endpoints:
//   POST /requests        {agentKey, profile?}  -> {requestId, url}
//       Creates a zkPassport request scoped to our domain, binds the agent's
//       Ed25519 public key into the proof (`custom_data`), and returns the QR
//       `url`. The phone (real or a devMode mock passport) scans it; the proof
//       is relayed back over the zkPassport bridge and captured in memory.
//   GET  /requests/:id    -> {status, verified, uniqueIdentifier, disclosed, bundle}
//       Poll until status==="complete"; `bundle` is the verifiable artifact the
//       skill embeds in its DelegationToken.
//   POST /verify          {proofs, query, queryResult} -> {verified, uniqueIdentifier, disclosed, boundAgentKey}
//       Stateless re-verification, used by the broker on every envelope. The
//       passed `query` is the original query (carries the agent_key bind) so a
//       tampered query or a proof bound to a different agent_key fails here.
//
// Trust note: the broker MUST point /verify at a bridge instance it controls.
// Never trust verification performed by the agent's own bridge.

import express from "express";
import { ZKPassport } from "@zkpassport/sdk";
import {
  applyConstraints,
  mapDisclosedPredicates,
  DEFAULT_PROFILE,
} from "./disclosure.js";

const DOMAIN = process.env.ZKPASSPORT_DOMAIN || "hearme.network";
const DEV_MODE = (process.env.ZKPASSPORT_DEV_MODE || "1") === "1";
const SCOPE = process.env.ZKPASSPORT_SCOPE || "v1";
// Freshness window for the proof's "ID not expired" check. We re-verify a
// stored proof on every envelope, so this must comfortably exceed the
// DelegationToken TTL (~90d). Tradeoff documented in the PR/plan.
const VALIDITY = parseInt(
  process.env.ZKPASSPORT_VALIDITY_SECONDS || `${60 * 60 * 24 * 95}`,
  10,
);
const PORT = parseInt(process.env.PORT || "8787", 10);
// @aztec/bb.js writes CRS/artifacts here during verify (needs write access).
const WRITING_DIR = process.env.ZKPASSPORT_WRITING_DIR || "/tmp";

const zkPassport = new ZKPassport(DOMAIN);

/** requestId -> in-flight/complete onboarding request state. */
const pending = new Map();

const app = express();
app.use(express.json({ limit: "8mb" }));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, domain: DOMAIN, devMode: DEV_MODE, scope: SCOPE });
});

app.post("/requests", async (req, res) => {
  try {
    const agentKey = req.body?.agentKey;
    if (!agentKey || typeof agentKey !== "string") {
      return res.status(400).json({ error: "agentKey (string) is required" });
    }
    const profile = req.body?.profile || DEFAULT_PROFILE;

    const builder = await zkPassport.request({
      name: "Hearme",
      logo: "https://hearme.network/logo.png",
      purpose:
        "Prove you are a unique adult so your agent can answer on your behalf",
      scope: SCOPE,
      mode: "fast",
      validity: VALIDITY,
      devMode: DEV_MODE,
    });

    const { url, query, requestId, onProofGenerated, onResult, onReject, onError } =
      applyConstraints(builder, profile).bind("custom_data", agentKey).done();

    const entry = {
      status: "pending",
      url,
      query,
      profile,
      proofs: [],
      queryResult: null,
      uniqueIdentifier: null,
      verified: false,
      error: null,
    };
    pending.set(requestId, entry);

    onProofGenerated((proof) => entry.proofs.push(proof));
    onResult(({ uniqueIdentifier, verified, result }) => {
      entry.uniqueIdentifier = uniqueIdentifier ?? null;
      entry.verified = verified === true;
      entry.queryResult = result;
      entry.status = "complete";
    });
    onReject(() => {
      entry.status = "rejected";
    });
    onError((e) => {
      entry.status = "error";
      entry.error = String(e);
    });

    return res.json({ requestId, url });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/requests/:id", (req, res) => {
  const entry = pending.get(req.params.id);
  if (!entry) return res.status(404).json({ error: "unknown requestId" });

  const body = {
    status: entry.status,
    url: entry.url,
    verified: entry.verified,
    uniqueIdentifier: entry.uniqueIdentifier,
    error: entry.error,
  };
  if (entry.status === "complete") {
    body.disclosed = mapDisclosedPredicates(entry.queryResult);
    // The verifiable bundle the skill embeds in DelegationToken.zkpassport_proof.
    body.bundle = {
      version: 1,
      proofs: entry.proofs,
      query: entry.query,
      queryResult: entry.queryResult,
      scope: SCOPE,
    };
  }
  return res.json(body);
});

app.post("/verify", async (req, res) => {
  try {
    const { proofs, query, queryResult } = req.body || {};
    if (!Array.isArray(proofs) || !query || !queryResult) {
      return res
        .status(400)
        .json({ error: "proofs (array), query, queryResult are required" });
    }

    const out = await zkPassport.verify({
      proofs,
      originalQuery: query,
      queryResult,
      scope: SCOPE,
      devMode: DEV_MODE,
      validity: VALIDITY,
      writingDirectory: WRITING_DIR,
    });

    return res.json({
      verified: out.verified === true,
      uniqueIdentifier: out.uniqueIdentifier ?? null,
      uniqueIdentifierType: out.uniqueIdentifierType ?? null,
      disclosed: mapDisclosedPredicates(queryResult),
      // The agent_key the proof is bound to; the broker asserts this equals
      // the token's agent_key for a clear, debuggable rejection reason.
      boundAgentKey: query?.bind?.custom_data ?? null,
      queryResultErrors: out.queryResultErrors ?? null,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e), verified: false });
  }
});

import { pathToFileURL } from "node:url";

// Only bind a port when run directly (`node src/server.js`), so tests can
// import `app` without side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[zkpassport-bridge] listening on :${PORT} domain=${DOMAIN} devMode=${DEV_MODE} scope=${SCOPE}`,
    );
  });
}

export { app };
