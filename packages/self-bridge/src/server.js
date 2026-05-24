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

const SCOPE = process.env.SELF_SCOPE || "hearme-v1";
// No default: SelfAppBuilder rejects localhost/127.0.0.1, and the Self app POSTs
// proofs straight to this URL, so it must be publicly reachable (an ngrok https
// URL in dev). Validated in /requests and at startup via endpointProblem().
const ENDPOINT = process.env.SELF_ENDPOINT || "";
const ENDPOINT_TYPE = process.env.SELF_ENDPOINT_TYPE || "staging_https";
const MOCK_PASSPORT = (process.env.SELF_MOCK_PASSPORT || "1") === "1";
const PORT = parseInt(process.env.PORT || "8787", 10);

// requestId -> { agentKey, thresholds:[int], results: Map<normUserId,bundle> }
const pending = new Map();

// normUserId(userId hex) -> { requestId, threshold }. Lets /callback route a
// verified proof back to the request that created it. Keyed by the *numeric*
// value of the userId (via BigInt) so it survives any 0x-prefix / case /
// zero-padding differences in how the Self circuit echoes userIdentifier back.
const byUser = new Map();

function normUserId(h) {
  try {
    const s = String(h);
    return BigInt(s.startsWith("0x") ? s : "0x" + s).toString();
  } catch {
    return String(h);
  }
}

// Verifier config. We deliberately DO NOT set `minimumAge`: @selfxyz/core checks
// the config's minimumAge for EXACT equality against each proof's disclosed
// threshold (verify() throws ConfigMismatchError otherwise), so one fixed value
// cannot accept the [18,25,35,50,65] ladder — it would reject every proof except
// the 18 one. The age bound is still enforced inside each proof's circuit (the
// frontend requested the threshold); the bridge reads the satisfied threshold
// back from discloseOutput.minimumAge. `excludedCountries: []` is required shape
// (the SDK calls excludedCountries.every(...)); ofac is off in v0.
function makeVerifier() {
  const configStore = new DefaultConfigStore({
    excludedCountries: [],
    ofac: false,
  });
  return new SelfBackendVerifier(
    SCOPE,
    ENDPOINT,
    MOCK_PASSPORT, // true = Celo testnet (alfajores) + staging hub; false = mainnet hub
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

// SelfAppBuilder rejects localhost/127.0.0.1 and requires a value: the Self app
// POSTs the proof straight to this endpoint, so it must be publicly reachable
// (an ngrok https URL in dev). Surface the misconfig early and clearly instead
// of as a generic 500 from deep inside the builder.
function endpointProblem(ep) {
  if (!ep) return "SELF_ENDPOINT is not set";
  if (ep.includes("localhost") || ep.includes("127.0.0.1")) {
    return `SELF_ENDPOINT must be publicly reachable, not localhost (got "${ep}") — use an ngrok/https URL`;
  }
  return null;
}

async function verifyOne({ attestationId, proof, publicSignals, userContextData }) {
  // The on-chain registry/root check is done by @selfxyz/core itself: verify()
  // reads the IdentityVerificationHub on Celo (mainnet forno when MOCK_PASSPORT
  // is false; alfajores testnet + staging hub when true), resolves the per-
  // attestation Registry, and calls checkIdentityCommitmentRoot(root) where
  // `root` is publicSignals[merkleRootIndex]. If the proof's Merkle root is not
  // live on-chain it throws (InvalidRoot / "Registry contract not found"). So a
  // verify() that returns has already confirmed the root against Self's real
  // registry — that IS the Sybil-hardening anchor (ARCHITECTURE.md §5); the
  // bridge needs no extra eth_call. (Requires outbound access to the Celo RPC.)
  const result = await verifier().verify(
    attestationId,
    proof,
    publicSignals,
    userContextData,
  );
  const verified = result?.isValidDetails?.isValid === true;
  const boundHex = result?.userData?.userDefinedData;
  return {
    verified,
    uniqueIdentifier: result?.discloseOutput?.nullifier ?? null,
    disclosed: mapDisclosed(result?.discloseOutput),
    boundAgentKey: boundHex ? hexToB64(boundHex) : null,
    // verify() throws unless the root is live on-chain, so a verified proof is
    // necessarily registry-confirmed.
    registryConfirmed: verified,
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
    // The on-chain root check is built into @selfxyz/core's verify() (always on).
    registryCheck: true,
    endpointOk: endpointProblem(ENDPOINT) === null,
  });
});

app.post("/requests", async (req, res) => {
  try {
    const agentKey = req.body?.agentKey;
    if (!agentKey || typeof agentKey !== "string") {
      return res.status(400).json({ error: "agentKey (string) is required" });
    }
    const epErr = endpointProblem(ENDPOINT);
    if (epErr) return res.status(500).json({ error: epErr });
    const profile = req.body?.profile || DEFAULT_PROFILE;
    const thresholds = profileThresholds(profile);
    const requestId = cryptoRandomId();
    const userDefinedData = b64ToHex(agentKey);

    const urls = thresholds.map((threshold) => {
      // userIdType "hex" requires a 0x-prefixed hex field element; the old
      // `${requestId}-${threshold}` was not valid hex and made /requests 500.
      // Mint a fresh random hex id per proof and remember how to route it back.
      const userId = "0x" + cryptoRandomId();
      byUser.set(normUserId(userId), { requestId, threshold });
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
    // Route by the userId we minted per (requestId, threshold) in /requests.
    const routed = byUser.get(normUserId(out.userIdentifier || ""));
    const entry = routed ? pending.get(routed.requestId) : undefined;
    if (entry) {
      entry.results.set(normUserId(out.userIdentifier), {
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
      `[self-bridge] listening on :${PORT} scope=${SCOPE} mockPassport=${MOCK_PASSPORT} (on-chain root check via @selfxyz/core)`,
    );
    const epErr = endpointProblem(ENDPOINT);
    if (epErr) {
      // eslint-disable-next-line no-console
      console.warn(
        `[self-bridge] WARNING: ${epErr} — /requests will fail until SELF_ENDPOINT is fixed`,
      );
    }
  });
}

export { app };
