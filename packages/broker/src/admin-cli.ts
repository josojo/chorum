// Asker-admin CLI — manage the DB-backed bootstrap valve (ARCHITECTURE.md §15.3).
//
// Admins bypass the answer-credit unlock threshold and may always ask. The list
// lives in the `asker_admins` table (broker-owned) and the broker reads it live,
// so grants/revokes take effect WITHOUT a restart — unlike the static
// HEARME_BROKER_ASKER_ADMIN_IDENTIFIERS env allowlist, which this complements.
//
// Identities are Self nullifiers (`unique_identifier`) — opaque, never shown to
// the user. `grant --name` resolves a nullifier from the display name an identity
// has asked under (via the askers table); for someone who has never asked there
// is no name on record, so `grant --id <nullifier>` is the escape hatch.
//
// Run with tsx (see package.json "admin"):
//   npm run admin -- list
//   npm run admin -- grant --id self:abc123 --label "Alice (founder)"
//   npm run admin -- grant --name "Alice"
//   npm run admin -- revoke --id self:abc123
// The `--` is required so npm forwards the flags to the script rather than eating
// them. DATABASE_URL / HEARME_BROKER_* env vars select the target database.

import { closeDb, getDb, initDb } from "./db";
import * as q from "./queries";

interface Args {
  command: string | undefined;
  id?: string;
  name?: string;
  label?: string;
}

// Minimal flag parser: one positional command, then --id/--name/--label <value>.
function parseArgs(argv: string[]): Args {
  const out: Args = { command: undefined };
  let i = 0;
  if (argv[i] && !argv[i].startsWith("--")) {
    out.command = argv[i];
    i++;
  }
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--id") out.id = argv[++i];
    else if (a === "--name") out.name = argv[++i];
    else if (a === "--label") out.label = argv[++i];
    else {
      throw new UsageError(`unknown argument: ${a}`);
    }
  }
  return out;
}

class UsageError extends Error {}

const USAGE = `asker-admin — manage DB-backed asker admins (§15.3)

Usage:
  npm run admin -- list
  npm run admin -- grant --id <nullifier> [--label <text>]
  npm run admin -- grant --name "<display name>"   [--label <text>]
  npm run admin -- revoke --id <nullifier>

Notes:
  - <nullifier> is the Self unique_identifier (e.g. "self:...").
  - --name resolves the nullifier from the name an identity has asked under;
    it must match exactly one identity. A never-asked identity has no name —
    use --id for those.`;

// Truncate an opaque nullifier for display without losing the ability to tell
// rows apart.
function short(uid: string): string {
  return uid.length > 28 ? `${uid.slice(0, 25)}…` : uid;
}

async function cmdList(): Promise<void> {
  const rows = await q.listAskerAdmins(getDb());
  if (rows.length === 0) {
    console.log("No asker admins. Add one with `grant`.");
    return;
  }
  console.log(`${rows.length} asker admin${rows.length === 1 ? "" : "s"}:\n`);
  for (const r of rows) {
    const name = r.displayName ? ` · asks as "${r.displayName}"` : "";
    const label = r.label ? ` · ${r.label}` : "";
    console.log(`  ${short(r.uniqueIdentifier)}${label}${name}`);
  }
}

async function resolveNameToId(name: string): Promise<string> {
  const matches = await q.findAskerIdentitiesByName(getDb(), name);
  if (matches.length === 0) {
    throw new UsageError(
      `No identity has asked under the name "${name}". ` +
        `If they've never asked, promote them by nullifier: grant --id <nullifier>.`,
    );
  }
  if (matches.length > 1) {
    const lines = matches
      .map((m) => `    --id ${m.uniqueIdentifier}   (asked ${m.createdAt.toISOString()})`)
      .join("\n");
    throw new UsageError(
      `"${name}" matches ${matches.length} distinct identities — names aren't unique.\n` +
        `Re-run with the specific nullifier:\n${lines}`,
    );
  }
  return matches[0].uniqueIdentifier;
}

async function cmdGrant(args: Args): Promise<void> {
  if (args.id && args.name) {
    throw new UsageError("pass either --id or --name, not both");
  }
  let uid: string;
  let label = args.label ?? null;
  if (args.id) {
    uid = args.id;
  } else if (args.name) {
    uid = await resolveNameToId(args.name);
    // Default the human label to the resolved name when none was given.
    if (label === null) label = args.name;
  } else {
    throw new UsageError("grant requires --id <nullifier> or --name <display name>");
  }
  await q.grantAskerAdmin(getDb(), { uniqueIdentifier: uid, label });
  console.log(`Granted admin: ${short(uid)}${label ? ` (${label})` : ""}`);
  console.log("Takes effect on their next ask — no broker restart needed.");
}

async function cmdRevoke(args: Args): Promise<void> {
  if (!args.id) {
    throw new UsageError("revoke requires --id <nullifier>");
  }
  const removed = await q.revokeAskerAdmin(getDb(), args.id);
  console.log(
    removed
      ? `Revoked admin: ${short(args.id)}`
      : `${short(args.id)} was not an admin (nothing to revoke).`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || args.command === "help" || args.command === "--help") {
    console.log(USAGE);
    return;
  }
  await initDb();
  try {
    switch (args.command) {
      case "list":
        await cmdList();
        break;
      case "grant":
        await cmdGrant(args);
        break;
      case "revoke":
        await cmdRevoke(args);
        break;
      default:
        throw new UsageError(`unknown command: ${args.command}`);
    }
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  if (err instanceof UsageError) {
    console.error(`error: ${err.message}\n`);
    console.error(USAGE);
    process.exit(2);
  }
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
