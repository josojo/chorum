// Disclosure policy: the single source of truth for what a hearme identity
// proof asserts, and how a zkPassport QueryResult collapses into the
// `disclosed_predicates` the broker stores and the eligibility layer reads.
//
// v0 ships one privacy-preserving profile ("eu-adult"): it proves age >= 18
// and EU membership WITHOUT revealing the exact age or country. Add profiles
// here as the product needs finer scopes; keep the QueryResult -> predicates
// mapping deterministic so the skill (builder) and broker (re-verify) agree.

import { EU_COUNTRIES } from "@zkpassport/sdk";

export const DEFAULT_PROFILE = "eu-adult";

/**
 * Apply a profile's disclosure constraints to a zkPassport query builder.
 * Returns the builder so callers can keep chaining (e.g. `.bind(...)`).
 */
export function applyConstraints(builder, profile = DEFAULT_PROFILE) {
  switch (profile) {
    case "eu-adult":
    default:
      return builder.gte("age", 18).in("nationality", EU_COUNTRIES);
  }
}

/**
 * Collapse a verified zkPassport QueryResult into hearme predicate keys.
 * Pure + deterministic: the same QueryResult always yields the same dict, so
 * the broker reproduces exactly what the skill embedded in the token.
 */
export function mapDisclosedPredicates(queryResult) {
  const out = {};
  const r = queryResult || {};
  if (r.age?.gte?.result === true) {
    out.age_band = "18+";
  }
  if (r.nationality?.in?.result === true) {
    out.region = "EU";
  }
  return out;
}
