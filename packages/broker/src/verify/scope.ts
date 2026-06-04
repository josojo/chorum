// The broker's identity scope — the `scope` claim stamped into every
// DelegationToken / asker-session credential, the value its Ed25519 signature is
// bound to, and the value an incoming credential's scope is checked against
// (delegation.ts / askerSession.ts). It MUST equal the self-bridge's Self scope
// (SELF_SCOPE), because the nullifier (`unique_identifier`) it accompanies is
// derived under that scope.
//
// It is FROZEN: changing it in an environment invalidates every credential there
// (the signed payload and the scope check both shift), and — together with the
// per-env signing key — it is what keeps a staging credential from ever being
// accepted by prod and vice versa. See docs/DEPLOYMENT.md "Frozen constants —
// never change in prod" and IDENTITY.md (GH #97).
//
// PRODUCTION_SCOPE is the permanent mainnet value. In production
// (HEARME_BROKER_PRODUCTION_MODE=1) the effective scope is ALWAYS this constant —
// HEARME_BROKER_SELF_SCOPE is ignored — so a config change can never silently
// re-label every credential or weaken the cross-environment barrier (fail-safe,
// mirroring the self-bridge). Outside prod, HEARME_BROKER_SELF_SCOPE selects the
// scope (staging pins "staging-hearme-v1") so it matches that env's bridge scope.
export const PRODUCTION_SCOPE = "hearme-v1";

// Resolve the effective broker scope. Returns the scope and, when prod is
// overriding an explicit HEARME_BROKER_SELF_SCOPE, the value it chose to ignore
// so the caller can warn loudly. Pure — safe to unit-test.
export function resolveScope({
  productionMode,
  envScope,
}: {
  productionMode: boolean;
  envScope?: string | undefined;
}): { scope: string; ignoredEnvScope: string | null } {
  if (productionMode) {
    const ignoredEnvScope =
      envScope && envScope !== PRODUCTION_SCOPE ? envScope : null;
    return { scope: PRODUCTION_SCOPE, ignoredEnvScope };
  }
  return { scope: envScope || PRODUCTION_SCOPE, ignoredEnvScope: null };
}
