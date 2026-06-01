// Broker runtime configuration.
//
// Environment-driven (prefix HEARME_BROKER_). The DATABASE_URL points at the
// shared Postgres using the `hearme_broker` role (see db/init/02-roles.sh).
// Defaults match the docker-compose dev environment so a fresh `dev-up.sh` can
// boot straight out of the box. Mirrors the Python config.py one-for-one.

// Dev-only Ed25519 seed for the broker signing key (base64 of 32 bytes).
// Production MUST override HEARME_BROKER_SIGNING_KEY with a secret-managed key;
// a stable key is required so DelegationTokens survive broker restarts.
// b"BROKER-SIGNING-KEY-HEARME-DEV32B"
export const DEV_BROKER_SIGNING_KEY = "QlJPS0VSLVNJR05JTkctS0VZLUhFQVJNRS1ERVYzMkI=";

export interface Settings {
  databaseUrl: string;
  dbPoolMinSize: number;
  dbPoolMaxSize: number;
  // v0 returns detailed rejection reasons to help integration. Production
  // should set this false (avoid being an oracle — see ARCHITECTURE.md §5).
  exposeRejectionReasons: boolean;

  // self-bridge: the Node sidecar that runs @selfxyz/core's SelfBackendVerifier
  // (off-chain SNARK) + the one-time on-chain Celo registry/root check. The
  // broker calls it ONLY at POST /v1/register (verify-once); never per envelope.
  selfBridgeUrl: string;
  selfVerifyTimeoutSeconds: number;

  // Sybil hardening (ARCHITECTURE.md §5): require the bridge's one-time on-chain
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

  // DANGER — testing only. When true, mounts POST /v1/dev/register, which mints
  // a DelegationToken for a SYNTHETIC identity WITHOUT any Self proof or bridge
  // verification. MUST stay false in production.
  devInsecureRegister: boolean;

  // When true, run startupChecks before the app is built and refuse to boot if
  // any documented dev default is still set.
  productionMode: boolean;

  // Per-client rate limiting on write endpoints (ratelimit.ts). Set any limit
  // to 0 to disable that rule.
  ratelimitEnabled: boolean;
  ratelimitRegisterPerHour: number;
  ratelimitEnvelopesPerMinute: number;
  ratelimitRevokePerMinute: number;
  ratelimitTrustProxyHeaders: boolean;
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

    devInsecureRegister: envBool(`${P}DEV_INSECURE_REGISTER`, false),
    productionMode: envBool(`${P}PRODUCTION_MODE`, false),

    ratelimitEnabled: envBool(`${P}RATELIMIT_ENABLED`, true),
    ratelimitRegisterPerHour: envNum(`${P}RATELIMIT_REGISTER_PER_HOUR`, 3),
    ratelimitEnvelopesPerMinute: envNum(`${P}RATELIMIT_ENVELOPES_PER_MINUTE`, 30),
    ratelimitRevokePerMinute: envNum(`${P}RATELIMIT_REVOKE_PER_MINUTE`, 10),
    ratelimitTrustProxyHeaders: envBool(`${P}RATELIMIT_TRUST_PROXY_HEADERS`, true),
  };
  return { ...settings, ...overrides };
}
