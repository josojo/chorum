// hearme self-bridge — the only place real Self (self.xyz) proofs are created
// and verified. The Python broker and skill talk to it over HTTP because
// @selfxyz/core (verify) and @selfxyz/qrcode (request creation) are Node-only.
//
// Verify-once model (ARCHITECTURE.md §5/§8): the bridge verifies proofs at
// REGISTRATION time only. Per answer the broker checks its own credential — the
// bridge is not in the path.
//
// Endpoints:
//   POST /requests   {agentKey, profile?} -> {requestId, urls[]}
//       Builds one SelfApp per age threshold (scope hearme-v1, endpoint =
//       this bridge's /callback, userDefinedData = agentKey). Returns the
//       universal-link/QR urls; the skill renders each in turn.
//   POST /callback   (the SelfApp endpoint) — the Self app POSTs a proof here;
//       the bridge verifies + stores it under the originating requestId.
//   GET  /requests/:id -> {status, verified, uniqueIdentifier, disclosed,
//       boundAgentKey, bundles[]} once all expected proofs are in.
//   POST /verify     {attestationId, proof, publicSignals, userContextData}
//       -> {verified, uniqueIdentifier, disclosed, boundAgentKey,
//           registryConfirmed}. Off-chain SNARK + one-time on-chain Celo
//       registry/root check. Called once at registration by the broker.
//
// Trust note: the broker MUST point /verify at a bridge instance it controls.

import express from "express";
// CONFIRM DURING IMPL (SELF_MIGRATION.md): exact @selfxyz export names/shapes.
import {
  SelfBackendVerifier,
  DefaultConfigStore,
  AllIds,
} from "@selfxyz/core";
import { SelfAppBuilder, getUniversalLink } from "@selfxyz/qrcode";

import {
  DEFAULT_PROFILE,
  disclosuresForThreshold,
  mapDisclosed,
  profileThresholds,
} from "./disclosure.js";
import { confirmRegistry } from "./registry.js";

const SCOPE = process.env.SELF_SCOPE || "hearme-v1";
const ENDPOINT = process.env.SELF_ENDPOINT || "http://localhost:8787/callback";
const ENDPOINT_TYPE = process.env.SELF_ENDPOINT_TYPE || "staging_https";
const MOCK_PASSPORT = (process.env.SELF_MOCK_PASSPORT || "1") === "1";
const CELO_RPC_URL = process.env.SELF_CELO_RPC_URL || "";
const REGISTRY_ADDRESS = process.env.SELF_REGISTRY_ADDRESS || "";
const PORT = parseInt(process.env.PORT || "8787", 10);

// requestId -> { agentKey, thresholds:[int], results: Map<userId,bundle> }
const pending = new Map();

// Permissive verifier config: minimumAge 18 is the gate; each proof attests its
// own (higher) threshold, read back from discloseOutput.olderThan. excluded /
// ofac are off in v0.
function makeVerifier() {
  const configStore = new DefaultConfigStore({
    minimumAge: 18,
    excludedCountries: [],
    ofac: false,
  });
  return new SelfBackendVerifier(
    SCOPE,
    ENDPOINT,
    MOCK_PASSPORT, // testnet/staging (Celo Sepolia) vs mainnet hub
    AllIds,
    configStore,
    "hex",
  );
}

let _verifier = null;
function verifier() {
  if (!_verifier) _verifier = makeVerifier();
  return _verifier;
}

const b64ToHex = (b64) => "0x" + Buffer.from(b64, "base64").toString("hex");
const hexToB64 = (hex) =>
  Buffer.from(hex.startsWith("0x") ? hex.slice(2) : hex, "hex").toString("base64");

// CONFIRM DURING IMPL: where the identity-registry Merkle root sits in the
// verified output / publicSignals. Isolated here so it's the only thing to fix.
function extractRoot(result, publicSignals) {
  return (
    result?.discloseOutput?.merkleRoot ??
    result?.merkleRoot ??
    (Array.isArray(publicSignals) ? publicSignals[0] : null)
  );
}

async function verifyOne({ attestationId, proof, publicSignals, userContextData }) {
  const result = await verifier().verify(
    attestationId,
    proof,
    publicSignals,
    userContextData,
  );
  const disclosed = mapDisclosed(result?.discloseOutput);
  const boundHex = result?.userData?.userDefinedData;
  const reg = await confirmRegistry({
    rpcUrl: CELO_RPC_URL,
    registryAddress: REGISTRY_ADDRESS,
    root: extractRoot(result, publicSignals),
  });
  return {
    verified: result?.isValidDetails?.isValid === true,
    uniqueIdentifier: result?.discloseOutput?.nullifier ?? null,
    disclosed,
    boundAgentKey: boundHex ? hexToB64(boundHex) : null,
    registryConfirmed: reg.confirmed,
    userIdentifier: result?.userData?.userIdentifier ?? null,
  };
}

const app = express();
app.use(express.json({ limit: "8mb" }));

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    scope: SCOPE,
    mockPassport: MOCK_PASSPORT,
    registryCheck: Boolean(CELO_RPC_URL && REGISTRY_ADDRESS),
  });
});

app.post("/requests", async (req, res) => {
  try {
    const agentKey = req.body?.agentKey;
    if (!agentKey || typeof agentKey !== "string") {
      return res.status(400).json({ error: "agentKey (string) is required" });
    }
    const profile = req.body?.profile || DEFAULT_PROFILE;
    const thresholds = profileThresholds(profile);
    const requestId = cryptoRandomId();
    const userDefinedData = b64ToHex(agentKey);

    const urls = thresholds.map((threshold) => {
      const userId = `${requestId}-${threshold}`;
      const selfApp = new SelfAppBuilder({
        appName: "Hearme",
        scope: SCOPE,
        endpoint: ENDPOINT,
        endpointType: ENDPOINT_TYPE,
        userId,
        userIdType: "hex",
        userDefinedData,
        disclosures: disclosuresForThreshold(threshold),
        version: 2,
      }).build();
      return getUniversalLink(selfApp);
    });

    pending.set(requestId, {
      agentKey,
      thresholds,
      results: new Map(),
    });
    return res.json({ requestId, urls });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// The SelfApp `endpoint`: the Self app POSTs proofs here.
app.post("/callback", async (req, res) => {
  try {
    const { attestationId, proof, publicSignals, userContextData } = req.body || {};
    if (attestationId == null || !proof || !publicSignals || !userContextData) {
      return res.status(400).json({ status: "error", reason: "malformed" });
    }
    const out = await verifyOne({ attestationId, proof, publicSignals, userContextData });
    // Route by the userIdentifier we set per (requestId, threshold).
    const reqId = (out.userIdentifier || "").split("-").slice(0, -1).join("-");
    const entry = pending.get(reqId);
    if (entry) {
      entry.results.set(out.userIdentifier, {
        bundle: { attestationId, proof, publicSignals, userContextData },
        ...out,
      });
    }
    // Ack shape the Self app expects.
    return res.json({ status: "success", result: out.verified === true });
  } catch (e) {
    return res.status(500).json({ status: "error", reason: String(e?.message || e) });
  }
});

app.get("/requests/:id", (req, res) => {
  const entry = pending.get(req.params.id);
  if (!entry) return res.status(404).json({ error: "unknown requestId" });

  const results = [...entry.results.values()];
  const complete = results.length >= entry.thresholds.length && results.length > 0;
  const body = { status: complete ? "complete" : "pending" };
  if (complete) {
    const allVerified = results.every((r) => r.verified);
    body.verified = allVerified;
    body.uniqueIdentifier = results[0]?.uniqueIdentifier ?? null;
    body.boundAgentKey = results[0]?.boundAgentKey ?? null;
    // The bundles the skill puts into EnrollmentBundle.self_proofs[].
    body.bundles = results.map((r) => r.bundle);
    body.disclosed = results.map((r) => r.disclosed);
    body.registryConfirmed = results.every((r) => r.registryConfirmed);
  }
  return res.json(body);
});

app.post("/verify", async (req, res) => {
  try {
    const { attestationId, proof, publicSignals, userContextData } = req.body || {};
    if (attestationId == null || !proof || !publicSignals || !userContextData) {
      return res.status(400).json({
        error: "attestationId, proof, publicSignals, userContextData required",
        verified: false,
      });
    }
    const out = await verifyOne({ attestationId, proof, publicSignals, userContextData });
    return res.json({
      verified: out.verified,
      uniqueIdentifier: out.uniqueIdentifier,
      disclosed: out.disclosed,
      boundAgentKey: out.boundAgentKey,
      registryConfirmed: out.registryConfirmed,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e), verified: false });
  }
});

function cryptoRandomId() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

import { pathToFileURL } from "node:url";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[self-bridge] listening on :${PORT} scope=${SCOPE} mockPassport=${MOCK_PASSPORT} registryCheck=${Boolean(
        CELO_RPC_URL && REGISTRY_ADDRESS,
      )}`,
    );
  });
}

export { app };
