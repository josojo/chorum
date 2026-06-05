// Reputation tiers (REFERRALS.md §4/§6).
//
// A pure mapping from a numeric reputation `score` to a tier label. The only
// LOAD-BEARING tier is "board": reaching it unlocks the governance claim
// (routes/board.ts). bronze/silver/gold are cosmetic milestones along the way —
// public-facing encouragement, no privilege attached. The board threshold is
// configurable (settings.repBoardThreshold) so the bar can be tuned during the
// bootstrap phase without a migration; the cosmetic milestones are fixed.
//
// Kept dependency-free and side-effect-free so both the crediting path
// (queries.ts) and the routes can compute a tier the same way.

// Cosmetic milestone floors, ascending. Evaluated below the board threshold.
const MILESTONES: ReadonlyArray<{ tier: string; min: number }> = [
  { tier: "bronze", min: 1 },
  { tier: "silver", min: 3 },
  { tier: "gold", min: 6 },
];

// The tier a given score earns. `boardThreshold` is the score at/above which an
// identity is on the board; below it, the highest cleared cosmetic milestone (or
// "none").
export function tierForScore(score: number, boardThreshold: number): string {
  if (score >= boardThreshold) return "board";
  let tier = "none";
  for (const m of MILESTONES) {
    if (score >= m.min) tier = m.tier;
  }
  return tier;
}
