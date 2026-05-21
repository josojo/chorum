// Disclosure policy for the self-bridge: the single source of truth for what a
// hearme identity proof asserts and how a verified Self result collapses into
// the per-proof ``disclosed`` shape the broker derives predicates from.
//
// Self has no native 5-year-band or "region" predicate. We disclose:
//   - nationality (ISO-3166 country) -> the broker maps to a continent/region
//   - minimumAge (one threshold per proof) -> the broker reconstructs an age
//     band from the multi-threshold ladder (ARCHITECTURE.md §8.3).
//
// Pure module: no SDK, no network — unit-tested directly.

export const DEFAULT_PROFILE = "standard";

// The age ladder; keep in sync with the broker's predicates.AGE_LADDER.
export const AGE_THRESHOLDS = (process.env.SELF_AGE_THRESHOLDS || "18,25,35,50,65")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isInteger(n));

/** Thresholds to request for a profile. ``minimal`` is the 18+ gate only. */
export function profileThresholds(profile = DEFAULT_PROFILE) {
  switch (profile) {
    case "minimal":
      return [18];
    case "standard":
    default:
      return AGE_THRESHOLDS.length ? AGE_THRESHOLDS : [18];
  }
}

/** Disclosure config for one threshold proof (passed to SelfAppBuilder). */
export function disclosuresForThreshold(threshold) {
  return { nationality: true, minimumAge: threshold };
}

/**
 * Collapse a verified Self ``discloseOutput`` into hearme's per-proof disclosed
 * dict: ``{ nationality, older_than }``. ``older_than`` is the minimumAge the
 * proof attested (the holder is at least that old). Deterministic + pure so the
 * broker reproduces exactly what was disclosed.
 */
export function mapDisclosed(discloseOutput) {
  const out = {};
  const d = discloseOutput || {};
  if (d.nationality) out.nationality = String(d.nationality);
  const older = d.olderThan ?? d.minimumAge;
  if (older !== undefined && older !== null && `${older}` !== "") {
    const n = parseInt(`${older}`, 10);
    if (Number.isInteger(n)) out.older_than = n;
  }
  return out;
}
