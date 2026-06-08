// Deterministic canonical JSON for hashing.
//
// ARCHITECTURE_V0.md §8.5:  delegation_hash = SHA-256(canonical_json(delegation_token))
//
// Properties required (match the Python verify/canonical.py and, crucially, the
// chorum-skill which independently computes delegation_hash and signs over it):
//   - Object keys sorted lexicographically at every nesting level.
//   - No insignificant whitespace (Python separators=(",",":")).
//   - UTF-8 bytes out.
//   - Stable across input key ordering.
//
// For the values the broker actually canonicalizes — objects, arrays, strings,
// the integer `version: 2` — JSON.stringify over a recursively key-sorted clone
// is byte-identical to Python's json.dumps(sort_keys=True, separators=(",",":"),
// ensure_ascii=False). (No floats, no non-ASCII, no control characters appear in
// a DelegationToken, so the escaping rules coincide.) Verified against a golden
// vector recorded from the Python broker.

import { createHash } from "node:crypto";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

// Serialize `obj` to canonical-JSON bytes. Pure function: two semantically equal
// inputs MUST produce identical bytes.
export function canonicalJson(obj: unknown): Buffer {
  // JSON.stringify with no spacing already emits compact `,`/`:` separators.
  return Buffer.from(JSON.stringify(sortKeys(obj)), "utf-8");
}

// SHA-256 of the canonical-JSON encoded DelegationToken, hex.
export function delegationHash(token: unknown): string {
  return createHash("sha256").update(canonicalJson(token)).digest("hex");
}
