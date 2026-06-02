// Asker gating — the v0 unlock threshold of the answer-credit economy
// (ARCHITECTURE_V0.md §14.2).
//
// Asking is the one action that imposes cost on the whole network: a dispatched
// question fans out to answering agents, each of which spends its own inference
// to answer. To stop that externality without money (payments are deferred to
// v0.3, §11) or a third-party identity (X/Self-on-asker), v0 gates asking on
// *contribution*: an identity may post questions only once it has supplied
// enough answers — and enough of them opinion-bearing.
//
// This module is the pure decision: given an identity's answer counts, the
// configured thresholds, and whether it is an admin, decide whether it may ask.
// The DB count lives in queries.ts (askerAnswerCounts); the HTTP surface is
// routes/askers.ts. Kept pure (no DB, no I/O) so it is exhaustively unit-tested.

export interface AskerAnswerCounts {
  // Total accepted answers (envelopes) this identity has ever submitted.
  total: number;
  // Of those, the opinion-bearing ones. See queries.ts for the v0 proxy: until
  // the `no_signal` column (§1.14, §3) lands in the live schema, a non-empty
  // `answer` stands in for `no_signal = false`.
  signal: number;
}

export interface AskerGatingThresholds {
  // Minimum total answers required to unlock asking (default 50, §15.3).
  requiredTotal: number;
  // Minimum signal-bearing answers required (default 10, §15.3). This is the
  // anti-farming clause: it stops an identity from grinding cheap no-signal
  // envelopes just to buy ask-rights (§15.4).
  requiredSignal: number;
}

// Why an identity cannot ask yet. `null` reason ⇔ canAsk === true.
export const AskerBlockReason = {
  NOT_ENOUGH_ANSWERS: "not_enough_answers",
  NOT_ENOUGH_SIGNAL: "not_enough_signal",
} as const;

export type AskerBlockReason =
  (typeof AskerBlockReason)[keyof typeof AskerBlockReason];

export interface AskerEligibility {
  canAsk: boolean;
  isAdmin: boolean;
  totalAnswers: number;
  signalAnswers: number;
  requiredTotal: number;
  requiredSignal: number;
  // How many more answers of each kind are still needed (0 once satisfied).
  // Always 0 for admins. Useful for a "12 answers to go" UI nudge.
  remainingTotal: number;
  remainingSignal: number;
  reason: AskerBlockReason | null;
}

// Decide whether an identity may open a new question.
//
// Admins (and designated seed accounts) bypass the threshold entirely — the
// bootstrap valve of §15.3: the network needs questions in circulation before
// there is a body of answerers to earn against. Otherwise both thresholds must
// be met. The total floor is reported first when both fail, since it is the
// larger requirement and the more informative nudge.
export function evaluateAskerEligibility(args: {
  counts: AskerAnswerCounts;
  thresholds: AskerGatingThresholds;
  isAdmin: boolean;
}): AskerEligibility {
  const { counts, thresholds, isAdmin } = args;
  const { requiredTotal, requiredSignal } = thresholds;
  const totalAnswers = Math.max(0, Math.trunc(counts.total));
  const signalAnswers = Math.max(0, Math.trunc(counts.signal));

  const base = {
    isAdmin,
    totalAnswers,
    signalAnswers,
    requiredTotal,
    requiredSignal,
  };

  if (isAdmin) {
    return {
      ...base,
      canAsk: true,
      remainingTotal: 0,
      remainingSignal: 0,
      reason: null,
    };
  }

  const remainingTotal = Math.max(0, requiredTotal - totalAnswers);
  const remainingSignal = Math.max(0, requiredSignal - signalAnswers);

  let reason: AskerBlockReason | null = null;
  if (remainingTotal > 0) reason = AskerBlockReason.NOT_ENOUGH_ANSWERS;
  else if (remainingSignal > 0) reason = AskerBlockReason.NOT_ENOUGH_SIGNAL;

  return {
    ...base,
    canAsk: reason === null,
    remainingTotal,
    remainingSignal,
    reason,
  };
}

// Parse the comma/whitespace-separated admin allowlist from config into a Set of
// unique_identifiers. Empty/blank entries are dropped.
export function parseAdminIdentifiers(raw: string): Set<string> {
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}
