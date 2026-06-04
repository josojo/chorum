// Refuse to start in production with development defaults.
//
// config.ts ships dev defaults so a fresh dev-up.sh boots out of the box. Those
// defaults — the dev signing key, the dev Postgres password, the dev-bypass
// registration route — are catastrophic in production. When
// HEARME_BROKER_PRODUCTION_MODE=1, server.ts calls enforceProductionConfig before
// the app is built; a misconfiguration throws and the process exits non-zero
// (failing closed). The check is structural only — no DB/bridge/chain contact.
// Mirrors startup_checks.py.

import { DEV_BROKER_SIGNING_KEY, DEV_SECRETS_DATABASE_URL, type Settings } from "./config";

// host:port of a Postgres DSN, for the separate-instance check below. Returns the
// raw DSN if it can't be parsed (so a malformed value can't masquerade as
// "different host" and slip past the guard).
function dsnHostPort(dsn: string): string {
  try {
    const u = new URL(dsn);
    return `${u.hostname}:${u.port || "5432"}`;
  } catch {
    return dsn;
  }
}

export class ProductionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionConfigError";
  }
}

export interface ValidationReport {
  errors: string[];
  warnings: string[];
}

export function validationOk(report: ValidationReport): boolean {
  return report.errors.length === 0;
}

// Apply every production-mode rule. Pure; safe to call from tests.
export function validateProductionConfig(settings: Settings): ValidationReport {
  const report: ValidationReport = { errors: [], warnings: [] };

  if (settings.brokerSigningKey === DEV_BROKER_SIGNING_KEY) {
    report.errors.push(
      "HEARME_BROKER_SIGNING_KEY is the documented dev default. Anyone with the " +
        "source can forge a DelegationToken — generate a fresh Ed25519 seed and " +
        "store it in your secret manager.",
    );
  }

  // Per-question linkage secrets (ADR-098, §1.4) must live in a SEPARATE Postgres
  // instance from the envelopes data. RDS backup retention is instance-wide, so a
  // shared instance silently inherits the main instance's long retention as the
  // secret's deletion horizon — defeating the whole "destroy at close" guarantee.
  if (settings.secretsDatabaseUrl === DEV_SECRETS_DATABASE_URL) {
    report.errors.push(
      "HEARME_BROKER_SECRETS_DATABASE_URL is the documented dev default (the shared " +
        "dev Postgres). The per-question voter-tag secrets (ADR-098) must live in a " +
        "separate, short-retention instance. Provision one and set this DSN.",
    );
  } else if (dsnHostPort(settings.secretsDatabaseUrl) === dsnHostPort(settings.databaseUrl)) {
    report.errors.push(
      "HEARME_BROKER_SECRETS_DATABASE_URL shares a host with HEARME_BROKER_DATABASE_URL. " +
        "The voter-tag secret store must be a SEPARATE Postgres instance with short " +
        "backup retention — on the same instance, RDS's instance-wide retention becomes " +
        "the secret's deletion horizon and 'destroy at close' (ADR-098) is cosmetic.",
    );
  }

  if (settings.databaseUrl.includes("hearme_broker_dev")) {
    report.errors.push(
      "HEARME_BROKER_DATABASE_URL still uses the dev password ('hearme_broker_dev'). " +
        "Rotate the password and update the DSN.",
    );
  }

  if (settings.devInsecureRegister) {
    report.errors.push(
      "HEARME_BROKER_DEV_INSECURE_REGISTER=1 mounts POST /v1/dev/register which mints " +
        "DelegationTokens for synthetic identities with NO Self proof. Set it to 0 in production.",
    );
  }

  if (!settings.requireRegistryConfirmation) {
    report.errors.push(
      "HEARME_BROKER_REQUIRE_REGISTRY_CONFIRMATION=0 skips the one-time on-chain Celo " +
        "registry/root check. That is the only anchor between Self's off-chain SNARK and " +
        "one-passport→one-identity (ARCHITECTURE_V0.md §5). Re-enable it.",
    );
  }

  if (settings.exposeRejectionReasons) {
    report.errors.push(
      "HEARME_BROKER_EXPOSE_REJECTION_REASONS=1 makes the broker a verification oracle " +
        "(an attacker learns which field of a forged envelope was wrong). Set it false in production.",
    );
  }

  // --- warnings: suspicious but not strictly blocking -----------------
  if (
    settings.selfBridgeUrl.includes("localhost") ||
    settings.selfBridgeUrl.includes("127.0.0.1")
  ) {
    report.warnings.push(
      `HEARME_BROKER_SELF_BRIDGE_URL='${settings.selfBridgeUrl}' points at localhost. ` +
        "OK if the bridge is a same-host sidecar; otherwise update.",
    );
  }

  return report;
}

// Run the validator and throw ProductionConfigError on any error. Warnings are
// logged either way; errors abort the process via exception.
export function enforceProductionConfig(
  settings: Settings,
  log: { warn: (msg: string) => void; info: (msg: string) => void } = console,
): void {
  const report = validateProductionConfig(settings);
  for (const w of report.warnings) log.warn(`startup-check: ${w}`);
  if (!validationOk(report)) {
    const joined = "\n  - " + report.errors.join("\n  - ");
    throw new ProductionConfigError(
      "Refusing to start in production mode with dev defaults:" + joined,
    );
  }
  log.info("startup-check: production_mode config OK");
}
