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
//   POST /web/requests   {} -> {requestId, url}
//       Keyless variant for the website's "verify to ask" gate: one SelfApp
//       (18+ personhood proof, no agentKey to bind). The web server calls this
//       internally and renders `url` as a QR; on completion it reads the
//       nullifier from GET /requests/:id and mints an asker session.
//   POST /callback   (the SelfApp endpoint) — the Self app POSTs a proof here;
//       the bridge verifies + stores it under the originating requestId. Proofs
//       for an agent request must bind the request's agentKey; web requests have
//       no agent key, so that bind is skipped for them.
//   GET  /requests/:id -> {status, verified, uniqueIdentifier, disclosed,
//       boundAgentKey, bundles[]} once all expected proofs are in.
//   POST /verify     {attestationId, proof, publicSignals, userContextData}
//       -> {verified, uniqueIdentifier, disclosed, boundAgentKey,
//           registryConfirmed}. Off-chain SNARK + one-time on-chain Celo
//       registry/root check. Called once at registration by the broker.
//
// Trust note: the broker MUST point /verify at a bridge instance it controls.

import express from "express";
// The @selfxyz SDK is imported lazily inside the handlers that use it (see
// verifier() and POST /requests), NOT at module load. Two reasons: it pulls a
// large transitive tree (qrcode -> react-spinners) whose ESM/CJS interop is
// fragile across installs, and keeping it out of the import graph lets tests
// import this module (and the test seams below) to exercise /callback's
// dispatch without the SDK or a real passport. CONFIRM DURING IMPL
// (SELF_MIGRATION.md): exact @selfxyz export names/shapes.

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
const MOCK_PASSPORT = (process.env.SELF_MOCK_PASSPORT || "0") === "1";
// The Self app only offers/accepts a MOCK passport when the request is in dev
// mode. SelfAppBuilder defaults devMode:false (production), which is why a
// mock-passport scan against a staging bridge silently fails. Default it to the
// mock-passport setting so SELF_MOCK_PASSPORT=1 ⇒ devMode:true. Override with
// SELF_DEV_MODE if needed.
const DEV_MODE =
  (process.env.SELF_DEV_MODE ?? (MOCK_PASSPORT ? "1" : "0")) === "1";
// Fail-closed production guard (mirrors the broker's startup_checks.py). The
// bridge is the ONLY place real Self proofs are verified, so a mock/dev posture
// in production silently accepts forged passports as real identities (sybil /
// personhood bypass) — and the misconfig (a dropped/typo'd SELF_MOCK_PASSPORT or
// SELF_DEV_MODE) would otherwise boot fine. When operators set
// SELF_PRODUCTION_MODE=1, refuse to start if mock passports or dev mode are on.
// Tests do NOT set SELF_PRODUCTION_MODE, so this never fires during a normal
// `import { app }` in CI; it only triggers under the real prod misconfiguration.
const SELF_PRODUCTION_MODE = (process.env.SELF_PRODUCTION_MODE || "0") === "1";
if (SELF_PRODUCTION_MODE && (MOCK_PASSPORT || DEV_MODE)) {
  // eslint-disable-next-line no-console
  console.error(
    "[self-bridge] FATAL: SELF_PRODUCTION_MODE=1 but mock/dev posture is on " +
      `(SELF_MOCK_PASSPORT=${MOCK_PASSPORT ? "1" : "0"}, SELF_DEV_MODE=${DEV_MODE ? "1" : "0"}). ` +
      "Refusing to start: a mock/dev bridge accepts forged passports as real " +
      "identities. Set SELF_MOCK_PASSPORT=0 and SELF_DEV_MODE=0 for production.",
  );
  process.exit(1);
}
// Optional chainID override. SelfAppBuilder otherwise picks 42220 (Celo
// mainnet) for endpointType=staging_https — wrong for a mock passport, whose
// commitment lives on Self's staging/testnet registry. If a mock scan fails on
// a network/root mismatch, set SELF_CHAIN_ID to the testnet the deployed
// @selfxyz/core checks (Celo Alfajores 44787 or Celo Sepolia 11142220).
const CHAIN_ID = process.env.SELF_CHAIN_ID
  ? parseInt(process.env.SELF_CHAIN_ID, 10)
  : undefined;
const PORT = parseInt(process.env.PORT || "8787", 10);

// Verbose request tracing for incident investigation. When on, every /requests,
// /callback, and /requests/:id poll is logged. Off by default so production
// logs stay focused on actual problems (which are always logged regardless).
const DEBUG_LOG = process.env.SELF_BRIDGE_DEBUG_LOG === "1";
function dbg(...args) {
  if (DEBUG_LOG) console.log("[self-bridge:debug]", ...args);
}

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

// Test seam: seed the routing tables the way /requests would (without building a
// real SelfApp via the SDK) so a /callback test can drive the dispatch path, and
// clear them between cases. Production never calls these.
export function __seedPending({
  requestId,
  thresholds,
  userId,
  threshold,
  agentKey = "test-agent-key",
  web = false,
}) {
  pending.set(requestId, { agentKey, web, thresholds, results: new Map() });
  byUser.set(normUserId(userId), { requestId, threshold });
}
export function __resetState() {
  pending.clear();
  byUser.clear();
  _verifyImpl = null;
}

// Verifier config. We deliberately DO NOT set `minimumAge`: @selfxyz/core checks
// the config's minimumAge for EXACT equality against each proof's disclosed
// threshold (verify() throws ConfigMismatchError otherwise), so one fixed value
// cannot accept the [18,25,35,50,65] ladder — it would reject every proof except
// the 18 one. The age bound is still enforced inside each proof's circuit (the
// frontend requested the threshold); the bridge reads the satisfied threshold
// back from discloseOutput.minimumAge. `excludedCountries: []` is required shape
// (the SDK calls excludedCountries.every(...)); ofac is off in v0.
async function makeVerifier() {
  const { SelfBackendVerifier, DefaultConfigStore, AllIds } = await import(
    "@selfxyz/core"
  );
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
async function verifier() {
  if (!_verifier) _verifier = await makeVerifier();
  return _verifier;
}

const b64ToHex = (b64) => "0x" + Buffer.from(b64, "base64").toString("hex");
const hexToB64 = (hex) =>
  Buffer.from(hex.startsWith("0x") ? hex.slice(2) : hex, "hex").toString("base64");

// SDK >= 1.1 stores `userDefinedData` as literal UTF-8 bytes (then hex-encoded into
// `userContextData`). We pass an "0x" + 64-hex agent key string; recover that ASCII
// first, then hex-decode it to the raw 32 bytes and base64 to match the skill.
function decodeBoundAgentKey(boundHex) {
  if (!boundHex) return null;
  let ascii;
  try { ascii = Buffer.from(boundHex, "hex").toString("utf8"); } catch { return null; }
  const inner = ascii.startsWith("0x") ? ascii.slice(2) : ascii;
  if (!/^[0-9a-fA-F]+$/.test(inner) || inner.length % 2 !== 0) return null;
  try { return Buffer.from(inner, "hex").toString("base64"); } catch { return null; }
}

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

// Test seam. /callback and /verify run a real ZK verification through
// @selfxyz/core against the Celo RPC, which cannot run in CI. Tests inject a
// deterministic stand-in here that returns an SDK-shaped result; production
// leaves this null and always uses the real verifier(). See test/callback.test.js.
let _verifyImpl = null;
export function __setVerifyImpl(fn) {
  _verifyImpl = fn;
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
  const result = _verifyImpl
    ? await _verifyImpl(attestationId, proof, publicSignals, userContextData)
    : await (await verifier()).verify(attestationId, proof, publicSignals, userContextData);
  const verified = result?.isValidDetails?.isValid === true;
  const boundHex = result?.userData?.userDefinedData;
  return {
    verified,
    uniqueIdentifier: result?.discloseOutput?.nullifier ?? null,
    disclosed: mapDisclosed(result?.discloseOutput),
    boundAgentKey: decodeBoundAgentKey(boundHex),
    // verify() throws unless the root is live on-chain, so a verified proof is
    // necessarily registry-confirmed.
    registryConfirmed: verified,
    userIdentifier: result?.userData?.userIdentifier ?? null,
    // Surfaced so /callback can log a meaningful reason when verify() returns
    // isValid:false (otherwise the failure is silently swallowed as 200 with
    // `result:false` — debugging the verify ladder is impossible without it).
    _isValidDetails: result?.isValidDetails ?? null,
  };
}

const app = express();
app.use(express.json({ limit: "8mb" }));

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    scope: SCOPE,
    mockPassport: MOCK_PASSPORT,
    devMode: DEV_MODE,
    chainID: CHAIN_ID ?? null,
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
    const { SelfAppBuilder, getUniversalLink } = await import("@selfxyz/qrcode");
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
        // devMode must be true for the Self app to accept a mock passport.
        devMode: DEV_MODE,
        // Only override chainID when explicitly configured; otherwise let the
        // SDK default for the chosen endpointType stand.
        ...(CHAIN_ID ? { chainID: CHAIN_ID } : {}),
      }).build();
      return getUniversalLink(selfApp);
    });

    pending.set(requestId, {
      agentKey,
      thresholds,
      results: new Map(),
    });
    dbg(
      `/requests created requestId=${requestId} thresholds=${JSON.stringify(thresholds)} ` +
      `pending.size=${pending.size} byUser.size=${byUser.size}`,
    );
    return res.json({ requestId, urls });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// Keyless web verification: one 18+ personhood proof, no agentKey to bind. The
// website's server calls this internally and renders the returned url as a QR.
app.post("/web/requests", async (_req, res) => {
  try {
    const epErr = endpointProblem(ENDPOINT);
    if (epErr) return res.status(500).json({ error: epErr });
    const { SelfAppBuilder, getUniversalLink } = await import("@selfxyz/qrcode");
    const threshold = 18;
    const requestId = cryptoRandomId();
    // userIdType "hex" needs a 0x-prefixed field element; mint a fresh one and
    // remember how to route the proof back. userDefinedData is unused for web
    // (no agent-key bind) but must be valid hex — reuse the requestId bytes.
    const userId = "0x" + cryptoRandomId();
    byUser.set(normUserId(userId), { requestId, threshold });
    const selfApp = new SelfAppBuilder({
      appName: "Hearme",
      scope: SCOPE,
      endpoint: ENDPOINT,
      endpointType: ENDPOINT_TYPE,
      userId,
      userIdType: "hex",
      userDefinedData: "0x" + requestId,
      disclosures: disclosuresForThreshold(threshold),
      version: 2,
      devMode: DEV_MODE,
      ...(CHAIN_ID ? { chainID: CHAIN_ID } : {}),
    }).build();
    const url = getUniversalLink(selfApp);
    pending.set(requestId, { web: true, thresholds: [threshold], results: new Map() });
    dbg(`/web/requests created requestId=${requestId} pending.size=${pending.size}`);
    return res.json({ requestId, url });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// The SelfApp `endpoint`: the Self app POSTs proofs here.
app.post("/callback", async (req, res) => {
  try {
    const { attestationId, proof, publicSignals, userContextData } = req.body || {};
    dbg(
      `/callback IN attestationId=${attestationId} ` +
      `proof?=${!!proof} publicSignals.len=${Array.isArray(publicSignals) ? publicSignals.length : "?"}`,
    );
    if (attestationId == null || !proof || !publicSignals || !userContextData) {
      console.warn("[self-bridge] /callback rejected: malformed body");
      return res.status(400).json({ status: "error", reason: "malformed" });
    }
    const out = await verifyOne({ attestationId, proof, publicSignals, userContextData });
    // Always log the WHY when a proof fails: today this is silently swallowed
    // as 200 + {result:false}, which makes debugging the verify ladder (mock
    // vs real, scope/endpoint mismatch, expired root, …) impossible.
    if (out.verified !== true) {
      console.warn(
        "[self-bridge] /callback verify returned isValid:false " +
          `isValidDetails=${JSON.stringify(out._isValidDetails)}`,
      );
    }
    // Route by the userId we minted per (requestId, threshold) in /requests.
    const normUid = normUserId(out.userIdentifier || "");
    const routed = byUser.get(normUid);
    const entry = routed ? pending.get(routed.requestId) : undefined;
    if (entry) {
      // Mandatory agent-key bind (fail-closed). The proof commits to
      // userDefinedData == the originating /requests call's agentKey; this is
      // what stops one human's verified passport from being attached to an
      // attacker-controlled agent key. A proof whose bound key is absent,
      // unparseable, or mismatched is DISCARDED (never stored), so it can never
      // bind the real nullifier to the wrong agent. Both values are base64
      // (decodeBoundAgentKey returns base64; /requests set userDefinedData =
      // b64ToHex(agentKey)), so a legitimate proof compares equal.
      //
      // Web requests (/web/requests) have no agent key — the website only needs
      // the personhood nullifier, not an agent binding — so skip the bind there.
      if (!entry.web && (!out.boundAgentKey || out.boundAgentKey !== entry.agentKey)) {
        console.warn(
          `[self-bridge] /callback agent-key bind FAILED for requestId=${routed.requestId} ` +
            `threshold=${routed.threshold} (bound=${out.boundAgentKey ? "present" : "null"}, ` +
            `match=${out.boundAgentKey === entry.agentKey}) — proof discarded`,
        );
        return res.json({ status: "success", result: out.verified === true });
      }
      entry.results.set(normUid, {
        bundle: { attestationId, proof, publicSignals, userContextData },
        ...out,
      });
      dbg(
        `/callback stored requestId=${routed.requestId} threshold=${routed.threshold} ` +
        `now=${entry.results.size}/${entry.thresholds.length}`,
      );
    } else {
      // Either the Self app echoed an unexpected userIdentifier or the bridge
      // was restarted between /requests and the proof landing. Either way the
      // skill will poll forever waiting for a bundle that won't arrive.
      console.warn(
        `[self-bridge] /callback could not route userIdentifier=${out.userIdentifier} ` +
        `(byUser.size=${byUser.size}) — proof discarded`,
      );
    }
    // Ack shape the Self app expects.
    return res.json({ status: "success", result: out.verified === true });
  } catch (e) {
    console.error("[self-bridge] /callback 500:", e?.stack || e);
    return res.status(500).json({ status: "error", reason: String(e?.message || e) });
  }
});

app.get("/requests/:id", (req, res) => {
  const entry = pending.get(req.params.id);
  if (!entry) {
    console.warn(
      `[self-bridge] /requests/${req.params.id} unknown (pending.size=${pending.size}) ` +
      `— skill polling for a requestId this bridge never minted (likely a restart)`,
    );
    return res.status(404).json({ error: "unknown requestId" });
  }

  const results = [...entry.results.values()];
  const complete = results.length >= entry.thresholds.length && results.length > 0;
  dbg(
    `/requests/${req.params.id} poll ` +
    `results=${results.length}/${entry.thresholds.length} status=${complete ? "complete" : "pending"}`,
  );
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
      `[self-bridge] listening on :${PORT} scope=${SCOPE} mockPassport=${MOCK_PASSPORT} devMode=${DEV_MODE} chainID=${CHAIN_ID ?? "(sdk default)"} debugLog=${DEBUG_LOG} (on-chain root check via @selfxyz/core)`,
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
