// Referral codes — the bootstrap incentive's capability tokens (REFERRALS.md §3).
//
// A code is an OPAQUE bearer token that carries zero identity: it is NOT derived
// from the referrer's Self nullifier (publishing that would collapse the
// answer-table unlinkability, §1). Only the broker can resolve a code back to a
// referrer, via the referral_codes table keyed by sha256(normalized code). We
// store only that hash, never the cleartext — a DB read-leak then cannot replay
// live codes; the cleartext is shown to the referrer exactly once at mint time.
//
// Format: HUM-XXXX-XXXX-XXXX-XXXX, where X is a Crockford base32 symbol (no
// I/L/O/U, which are easy to mistype). 16 symbols × 5 bits = 80 bits of entropy,
// so codes are not guessable / grindable even though redemption fails silently.

import { createHash, randomBytes } from "node:crypto";

// Crockford base32 alphabet — digits + uppercase letters minus I, L, O, U.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PREFIX = "HUM";
const GROUPS = 4;
const GROUP_LEN = 4;

// A fresh, human-friendly referral code (the cleartext shown to the referrer).
// Each symbol is a uniform draw over the 32-symbol alphabet (byte & 0x1f is
// unbiased: a uniform byte mod 32 is uniform over 0..31).
export function generateReferralCode(): string {
  const bytes = randomBytes(GROUPS * GROUP_LEN);
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    let group = "";
    for (let i = 0; i < GROUP_LEN; i++) {
      group += ALPHABET[bytes[g * GROUP_LEN + i] & 0x1f];
    }
    groups.push(group);
  }
  return `${PREFIX}-${groups.join("-")}`;
}

// Canonical form a code is hashed under, so formatting differences (case, the
// dashes, surrounding whitespace a user might paste) never change the lookup.
// Both mint (hash of the generated code) and redeem (hash of the submitted
// string) run this, so they agree byte-for-byte.
export function normalizeReferralCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// The stored / looked-up key for a code. sha256 hex of the normalized cleartext.
export function hashReferralCode(raw: string): string {
  return createHash("sha256").update(normalizeReferralCode(raw)).digest("hex");
}
