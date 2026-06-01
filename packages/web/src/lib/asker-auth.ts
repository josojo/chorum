// Asker auth — the web side of the answer-credit gate (ARCHITECTURE.md §15.3).
//
// Only the broker can read envelopes + registrations (db/init/02-roles.sh), so
// the asker's identity and eligibility are decided there. This module forwards
// the asker's pasted DelegationToken to POST /v1/askers/eligibility and turns
// the broker's verdict into a friendly result the /ask action can act on.
//
// v0 asker auth is possession of a broker-signed, live credential — not yet
// proof-of-private-key (see the broker route + §15.3). The token is not a secret
// the way a password is; it is a signed, expiring, revocable capability.

const BROKER_URL = process.env.BROKER_URL ?? "http://localhost:8000";

// Mirror of the broker's AskerEligibilityResponse (packages/broker/src/models.ts).
// Kept as a local type because web does not import broker code.
type BrokerEligibility = {
  authorized: boolean;
  auth_reason: string | null;
  unique_identifier: string | null;
  can_ask: boolean;
  is_admin: boolean;
  total_answers: number;
  signal_answers: number;
  required_total: number;
  required_signal: number;
  remaining_total: number;
  remaining_signal: number;
  reason: string | null;
};

export type AskerAuthResult =
  // Authenticated AND cleared the unlock threshold. uniqueIdentifier is verified.
  | { ok: true; uniqueIdentifier: string }
  // Rejected. `code` lets the caller decide UX; `message` is asker-facing.
  | {
      ok: false;
      code: "parse" | "unauthorized" | "blocked" | "broker_unreachable";
      message: string;
    };

function authMessage(reason: string | null): string {
  switch (reason) {
    case "token_expired":
      return "Your credential has expired. Re-onboard your agent to refresh it.";
    case "token_revoked":
    case "identity_revoked":
      return "This credential has been revoked.";
    case "registration_not_found":
      return "We don't recognize this credential. Is your agent registered?";
    case "registration_agent_mismatch":
      return "This credential doesn't match its registered agent key.";
    case "broker_signature_invalid":
      return "This credential isn't a valid, broker-issued token.";
    default:
      return "We couldn't verify your participant credential.";
  }
}

// "You've answered enough in total but too few with a real opinion" vs "answer
// more questions" — guide the asker to whichever floor they're short on (§15.3).
function gateMessage(j: BrokerEligibility): string {
  if (j.reason === "not_enough_signal") {
    return `Almost there — you need ${j.remaining_signal} more answer${
      j.remaining_signal === 1 ? "" : "s"
    } where your agent expressed a real opinion (not "no opinion") to unlock asking.`;
  }
  // not_enough_answers (or any other block)
  const n = j.remaining_total;
  return `Answer ${n} more question${
    n === 1 ? "" : "s"
  } to unlock asking. (You've supplied ${j.total_answers} of ${j.required_total}.)`;
}

// Authenticate the asker's credential and check the gate. Fail-closed: any error
// (malformed JSON, broker unreachable, non-2xx) returns ok:false.
export async function checkAskerEligibility(
  tokenRaw: string,
): Promise<AskerAuthResult> {
  let token: unknown;
  try {
    token = JSON.parse(tokenRaw);
  } catch {
    return {
      ok: false,
      code: "parse",
      message:
        "That credential isn't valid JSON. Paste the whole DelegationToken your agent received at onboarding.",
    };
  }

  let res: Response;
  try {
    res = await fetch(`${BROKER_URL}/v1/askers/eligibility`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delegation_token: token }),
      cache: "no-store",
    });
  } catch {
    return {
      ok: false,
      code: "broker_unreachable",
      message: "Couldn't reach the gate to verify your credential. Try again in a moment.",
    };
  }

  if (res.status === 422) {
    return {
      ok: false,
      code: "parse",
      message: "That credential is missing required fields. Paste the full DelegationToken.",
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      code: "broker_unreachable",
      message: "The gate is unavailable right now. Try again shortly.",
    };
  }

  const j = (await res.json()) as BrokerEligibility;
  if (!j.authorized) {
    return { ok: false, code: "unauthorized", message: authMessage(j.auth_reason) };
  }
  if (!j.can_ask || !j.unique_identifier) {
    return { ok: false, code: "blocked", message: gateMessage(j) };
  }
  return { ok: true, uniqueIdentifier: j.unique_identifier };
}
