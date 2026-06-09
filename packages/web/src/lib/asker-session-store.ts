// Persist a verified asker session across navigations within a visit.
//
// The asker session (verify/askerSession.ts) is a self-contained, broker-signed,
// ~30-min capability carrying its own `expires_at`; the broker re-verifies its
// signature + expiry on every /ask submit. Holding it only in React state meant
// it died on the post-submit redirect, forcing a fresh Self scan for every
// question. We stash the opaque JSON in sessionStorage so it survives navigations
// for the life of the tab, bounded by the SAME server-enforced TTL — never
// longer. sessionStorage (not localStorage) keeps it to "this visit": it's gone
// when the tab closes, and it's no more exposed to XSS than the in-memory state
// it replaces (that state was already readable, and already posted as a form
// field). The broker remains the sole authority — a tampered or stale blob just
// fails verification on submit.

const STORAGE_KEY = "chorum.askerSession";

// The opaque session is a JSON object; we only need its expiry to prune locally.
// Everything else stays opaque to the web tier (lib/asker-auth.ts).
type StoredShape = { expires_at?: unknown };

function expiresAtMs(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as StoredShape;
    if (typeof parsed.expires_at !== "string") return null;
    const ms = new Date(parsed.expires_at).getTime();
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

// Return the stored session JSON string if present and not yet expired, else
// null (clearing anything stale/malformed so we don't keep re-reading it).
export function loadStoredSession(): string | null {
  if (typeof window === "undefined") return null;
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // storage disabled (private mode, etc.) — just gate normally
  }
  if (!raw) return null;

  const expMs = expiresAtMs(raw);
  // Unparseable expiry ⇒ treat as unusable; an expired one is no good either.
  // Server clock is authoritative, but pruning locally avoids showing a form
  // whose session we already know the broker will reject.
  if (expMs === null || expMs <= Date.now()) {
    clearStoredSession();
    return null;
  }
  return raw;
}

export function storeSession(session: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, session);
  } catch {
    // Non-fatal: the session still works in-memory for this page load.
  }
}

export function clearStoredSession(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
