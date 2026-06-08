// The Self application scope — the value the Self circuit hashes into every
// nullifier (a user's unique_identifier). It is FROZEN: changing it in an
// environment gives every existing user there a brand-new identity (Sybil
// resistance resets, every `registrations` row orphans, every per-question voter
// tag stops matching), and there is NO migration path — old nullifiers cannot be
// re-derived under a new scope. See docs/DEPLOYMENT.md "Frozen constants — never
// change in prod" and IDENTITY.md (GH #97).
//
// PRODUCTION_SCOPE is the permanent mainnet value. In production
// (SELF_PRODUCTION_MODE=1) the effective scope is ALWAYS this constant —
// SELF_SCOPE is ignored — so a dropped, typo'd, or edited env var can never
// silently re-mint every production identity (fail-safe). Outside prod, SELF_SCOPE
// selects the scope (staging pins "staging-chorum-v1") so staging and dev keep an
// identity graph fully separate from mainnet.
//
// Kept in its own module (no SDK / no express imports) so the resolver can be
// unit-tested in the SDK-free smoke suite, like disclosure.js.
export const PRODUCTION_SCOPE = "chorum-v1";

// Resolve the effective Self scope. Returns the scope and, when prod is
// overriding an explicit SELF_SCOPE, the value it chose to ignore so the caller
// can warn loudly.
export function resolveScope({ productionMode, envScope }) {
  if (productionMode) {
    const ignoredEnvScope =
      envScope && envScope !== PRODUCTION_SCOPE ? envScope : null;
    return { scope: PRODUCTION_SCOPE, ignoredEnvScope };
  }
  return { scope: envScope || PRODUCTION_SCOPE, ignoredEnvScope: null };
}
