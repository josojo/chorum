// Site-wide experimental/beta notice. Intentionally NOT dismissable: every
// visitor should always see that this is a test build with no warranty — that
// expectation-setting is part of how we limit liability while running an
// unincorporated, invite-only test. The copy is env-overridable so a given
// deployment can soften/strengthen it without a code change.

const BANNER_TEXT =
  process.env.NEXT_PUBLIC_BETA_BANNER ??
  "Experimental test build — provided as-is, no warranty. Data may be reset or lost. For invited test users only.";

export function BetaBanner() {
  if (!BANNER_TEXT) return null;
  return (
    <div
      role="status"
      className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-center text-xs font-medium text-amber-800 sm:text-sm"
    >
      <span aria-hidden className="mr-1">
        🧪
      </span>
      {BANNER_TEXT}
    </div>
  );
}
