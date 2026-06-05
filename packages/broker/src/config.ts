// Broker runtime configuration.
//
// Environment-driven (prefix HEARME_BROKER_). The DATABASE_URL points at the
// shared Postgres using the `hearme_broker` role (see db/init/02-roles.sh).
// Defaults match the docker-compose dev environment so a fresh `dev-up.sh` can
// boot straight out of the box. Mirrors the Python config.py one-for-one.

import { resolveScope } from "./verify/scope";

// Dev-only Ed25519 seed for the broker signing key (base64 of 32 bytes).
// Production MUST override HEARME_BROKER_SIGNING_KEY with a secret-managed key;
// a stable key is required so DelegationTokens survive broker restarts.
// b"BROKER-SIGNING-KEY-HEARME-DEV32B"
export const DEV_BROKER_SIGNING_KEY = "QlJPS0VSLVNJR05JTkctS0VZLUhFQVJNRS1ERVYzMkI=";

// Dev default for the per-question linkage-secret store DSN (ADR-098). The
// secrets live in a broker-OWNED database (`hearme_secrets`) so the broker can
// create/destroy rows there (it has only USAGE, not CREATE, on the shared
// schema). In production this is co-located on the SAME RDS instance as the main
// DB (a separate database on it), which is why the at-rest secret is WRAPPED
// (below) — a dump of that instance then yields only ciphertext.
export const DEV_SECRETS_DATABASE_URL =
  "postgres://hearme_broker:hearme_broker_dev@localhost:5432/hearme_secrets";

// Dev-only master key (base64 of 32 bytes) that WRAPS each question's secret
// `s_q` at rest (AES-256-GCM, questionSecret.ts). Production MUST override
// HEARME_BROKER_VOTER_TAG_MASTER_KEY with a secret-managed key. Forward secrecy
// comes from DESTROYING a question's wrapped secret at close, not from this key:
// the master key can't decrypt a row that's been nulled, so a closed question's
// answers stay unlinkable even to a holder of the master key (ADR-098). It must
// stay stable — rotating it orphans the still-live wrapped secrets.
// b"HEARME-VOTER-TAG-SECRET-DEV-32B!"
export const DEV_VOTER_TAG_MASTER_KEY = "SEVBUk1FLVZPVEVSLVRBRy1TRUNSRVQtREVWLTMyQiE=";

export interface Settings {
  databaseUrl: string;
  dbPoolMinSize: number;
  dbPoolMaxSize: number;
  // v0 returns detailed rejection reasons to help integration. Production
  // should set this false (avoid being an oracle — see ARCHITECTURE_V0.md §5).
  exposeRejectionReasons: boolean;

  // self-bridge: the Node sidecar that runs @selfxyz/core's SelfBackendVerifier
  // (off-chain SNARK) + the one-time on-chain Celo registry/root check. The
  // broker calls it ONLY at POST /v1/register (verify-once); never per envelope.
  selfBridgeUrl: string;
  selfVerifyTimeoutSeconds: number;

  // Sybil hardening (ARCHITECTURE_V0.md §5): require the bridge's one-time on-chain
  // registry/Merkle-root confirmation at registration. Default true (prod).
  requireRegistryConfirmation: boolean;

  // Self on-chain invalidation listener. Disabled until production supplies the
  // concrete Self registry contract + revocation/update event ABI.
  selfRevocationListenerEnabled: boolean;
  selfRevocationRpcUrl: string;
  selfRevocationChainId: string;
  selfRevocationContractAddress: string;
  selfRevocationEventTopic: string;
  selfRevocationNullifierTopicIndex: number;
  selfRevocationNullifierDataWordIndex: number;
  selfRevocationFromBlock: number;
  selfRevocationConfirmations: number;
  selfRevocationPollIntervalSeconds: number;
  selfRevocationCursorName: string;

  // Ed25519 signing key (base64 of a 32-byte seed) the broker uses to sign the
  // DelegationToken it issues at registration. MUST be overridden in production.
  brokerSigningKey: string;

  // The identity scope stamped into every DelegationToken / asker-session and
  // checked against incoming credentials (verify/scope.ts). FROZEN, and must
  // equal the self-bridge's SELF_SCOPE. In production it is pinned to
  // PRODUCTION_SCOPE in code and HEARME_BROKER_SELF_SCOPE is ignored (GH #97);
  // staging sets it to "staging-hearme-v1".
  selfScope: string;

  // Per-question linkage-secret store (ADR-098, §1.4). A broker-owned database
  // (`hearme_secrets`) holding the `question_secrets` table; co-located on the
  // main RDS instance in production (secretsDb.ts).
  secretsDatabaseUrl: string;

  // Master key (base64, 32 bytes) that wraps each question's secret at rest
  // (AES-256-GCM, §1.4 / ADR-098). MUST be overridden in production. A DB-only
  // dump without it yields ciphertext; destroying a wrapped secret at close is
  // what makes a closed question unlinkable even to a holder of this key.
  voterTagMasterKey: string;

  // Voter-tag lifecycle (ADR-098). A question's linkage secret is destroyed
  // `voterTagGraceSeconds` after it closes (the grace window covers in-flight
  // revocations / aggregate recompute / disputes); the reaper sweeps every
  // `voterTagReapIntervalSeconds`. After destruction the question's answers are
  // unlinkable even to the broker.
  voterTagGraceSeconds: number;
  voterTagReapIntervalSeconds: number;

  // DANGER — testing only. When true, mounts POST /v1/dev/register, which mints
  // a DelegationToken for a SYNTHETIC identity WITHOUT any Self proof or bridge
  // verification. MUST stay false in production.
  devInsecureRegister: boolean;

  // When true, run startupChecks before the app is built and refuse to boot if
  // any documented dev default is still set.
  productionMode: boolean;

  // Observability (issue #101). logLevel tunes the pino logger; metricsEnabled
  // gates the Prometheus GET /metrics endpoint (default on — it is internal-only,
  // not routed by Caddy, see observability/metrics.ts). Sentry is configured via the
  // conventional SENTRY_* env vars (see observability/sentry.ts), not here.
  logLevel: string;
  metricsEnabled: boolean;

  // Per-client rate limiting on write endpoints (ratelimit.ts). Set any limit
  // to 0 to disable that rule.
  ratelimitEnabled: boolean;
  ratelimitRegisterPerHour: number;
  ratelimitEnvelopesPerMinute: number;
  ratelimitRevokePerMinute: number;
  ratelimitTrustProxyHeaders: boolean;

  // Asker gating — the v0 unlock threshold of the answer-credit economy
  // (ARCHITECTURE_V0.md §14.2). An identity may open questions only once it has
  // submitted at least `askerUnlockTotalAnswers` answers, of which at least
  // `askerUnlockSignalAnswers` are opinion-bearing (signal). `askerAdmin
  // Identifiers` is a comma/space-separated allowlist of unique_identifiers that
  // bypass the threshold (the bootstrap valve, §14.2).
  askerUnlockTotalAnswers: number;
  askerUnlockSignalAnswers: number;
  askerAdminIdentifiers: string;

  // Referrals & reputation (REFERRALS.md). A referrer may hold at most
  // `referralMaxActiveCodes` live (unexpired, unexhausted) codes at once; each
  // code expires after `referralCodeTtlDays`. A referral earns the referrer
  // `repPerActiveReferral` reputation once the referee crosses the §14.2 unlock
  // bar (the activation event). Reaching `repBoardThreshold` reputation unlocks
  // the governance/board claim. A board credential is valid for
  // `boardCredentialTtlDays`.
  referralMaxActiveCodes: number;
  referralCodeTtlDays: number;
  repPerActiveReferral: number;
  repBoardThreshold: number;
  boardCredentialTtlDays: number;
}

function envStr(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? def : v;
}

function envNum(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`${name} is not a number: ${v}`);
  return n;
}

// Booleans accept the same truthy forms pydantic-settings does ("1"/"true"/etc).
function envBool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  throw new Error(`${name} is not a boolean: ${v}`);
}

export function getSettings(overrides: Partial<Settings> = {}): Settings {
  const P = "HEARME_BROKER_";
  const settings: Settings = {
    databaseUrl: envStr(
      `${P}DATABASE_URL`,
      "postgres://hearme_broker:hearme_broker_dev@localhost:5432/hearme",
    ),
    dbPoolMinSize: envNum(`${P}DB_POOL_MIN_SIZE`, 1),
    dbPoolMaxSize: envNum(`${P}DB_POOL_MAX_SIZE`, 10),
    exposeRejectionReasons: envBool(`${P}EXPOSE_REJECTION_REASONS`, true),

    selfBridgeUrl: envStr(`${P}SELF_BRIDGE_URL`, "http://localhost:8787"),
    selfVerifyTimeoutSeconds: envNum(`${P}SELF_VERIFY_TIMEOUT_SECONDS`, 30.0),

    requireRegistryConfirmation: envBool(`${P}REQUIRE_REGISTRY_CONFIRMATION`, true),

    selfRevocationListenerEnabled: envBool(`${P}SELF_REVOCATION_LISTENER_ENABLED`, false),
    selfRevocationRpcUrl: envStr(`${P}SELF_REVOCATION_RPC_URL`, ""),
    selfRevocationChainId: envStr(`${P}SELF_REVOCATION_CHAIN_ID`, "celo"),
    selfRevocationContractAddress: envStr(`${P}SELF_REVOCATION_CONTRACT_ADDRESS`, ""),
    selfRevocationEventTopic: envStr(`${P}SELF_REVOCATION_EVENT_TOPIC`, ""),
    selfRevocationNullifierTopicIndex: envNum(`${P}SELF_REVOCATION_NULLIFIER_TOPIC_INDEX`, 1),
    selfRevocationNullifierDataWordIndex: envNum(`${P}SELF_REVOCATION_NULLIFIER_DATA_WORD_INDEX`, -1),
    selfRevocationFromBlock: envNum(`${P}SELF_REVOCATION_FROM_BLOCK`, 0),
    selfRevocationConfirmations: envNum(`${P}SELF_REVOCATION_CONFIRMATIONS`, 12),
    selfRevocationPollIntervalSeconds: envNum(`${P}SELF_REVOCATION_POLL_INTERVAL_SECONDS`, 15.0),
    selfRevocationCursorName: envStr(`${P}SELF_REVOCATION_CURSOR_NAME`, "self-revocations-v1"),

    brokerSigningKey: envStr(`${P}SIGNING_KEY`, DEV_BROKER_SIGNING_KEY),

    // Frozen in prod (HEARME_BROKER_SELF_SCOPE ignored, pinned in code); env-
    // selectable elsewhere. resolveScope mirrors the self-bridge (GH #97).
    selfScope: resolveScope({
      productionMode: envBool(`${P}PRODUCTION_MODE`, false),
      envScope: process.env[`${P}SELF_SCOPE`],
    }).scope,

    secretsDatabaseUrl: envStr(`${P}SECRETS_DATABASE_URL`, DEV_SECRETS_DATABASE_URL),
    voterTagMasterKey: envStr(`${P}VOTER_TAG_MASTER_KEY`, DEV_VOTER_TAG_MASTER_KEY),
    voterTagGraceSeconds: envNum(`${P}VOTER_TAG_GRACE_SECONDS`, 604_800), // 7 days
    voterTagReapIntervalSeconds: envNum(`${P}VOTER_TAG_REAP_INTERVAL_SECONDS`, 3_600),

    devInsecureRegister: envBool(`${P}DEV_INSECURE_REGISTER`, false),
    productionMode: envBool(`${P}PRODUCTION_MODE`, false),

    logLevel: envStr(`${P}LOG_LEVEL`, "info"),
    metricsEnabled: envBool(`${P}METRICS_ENABLED`, true),

    ratelimitEnabled: envBool(`${P}RATELIMIT_ENABLED`, true),
    ratelimitRegisterPerHour: envNum(`${P}RATELIMIT_REGISTER_PER_HOUR`, 3),
    ratelimitEnvelopesPerMinute: envNum(`${P}RATELIMIT_ENVELOPES_PER_MINUTE`, 30),
    ratelimitRevokePerMinute: envNum(`${P}RATELIMIT_REVOKE_PER_MINUTE`, 10),
    ratelimitTrustProxyHeaders: envBool(`${P}RATELIMIT_TRUST_PROXY_HEADERS`, true),

    askerUnlockTotalAnswers: envNum(`${P}ASKER_UNLOCK_TOTAL_ANSWERS`, 50),
    askerUnlockSignalAnswers: envNum(`${P}ASKER_UNLOCK_SIGNAL_ANSWERS`, 10),
    askerAdminIdentifiers: envStr(`${P}ASKER_ADMIN_IDENTIFIERS`, ""),

    referralMaxActiveCodes: envNum(`${P}REFERRAL_MAX_ACTIVE_CODES`, 20),
    referralCodeTtlDays: envNum(`${P}REFERRAL_CODE_TTL_DAYS`, 90),
    repPerActiveReferral: envNum(`${P}REP_PER_ACTIVE_REFERRAL`, 1),
    repBoardThreshold: envNum(`${P}REP_BOARD_THRESHOLD`, 10),
    boardCredentialTtlDays: envNum(`${P}BOARD_CREDENTIAL_TTL_DAYS`, 180),
  };
  return { ...settings, ...overrides };
}
