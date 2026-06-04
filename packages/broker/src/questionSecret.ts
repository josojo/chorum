// Per-question linkage-secret lifecycle (ADR-098, ARCHITECTURE_V0.md §1.4).
//
// Each question gets its OWN independently-random 32-byte secret `s_q`, used to
// derive that question's voter tags (voterTag.ts). The secret is created lazily
// on the first answer and DESTROYED a grace period after the question closes.
// Once destroyed, no one — not even the broker — can re-derive that question's
// tags from a nullifier, so its answers are cryptographically orphaned from every
// identity, permanently. This bounds the re-identification liability to the live
// working set (open questions + a short trailing window) instead of letting it
// accumulate forever behind one global secret (the #98 problem).
//
// `s_q` is NEVER derived from a longer-lived key — that would make deletion
// cosmetic. It is fresh CSPRNG bytes, stored only in the secrets instance
// (secretsDb.ts), and the destroy is a real row mutation whose irreversibility is
// the secrets instance's (short) backup retention.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { getSettings } from "./config";
import { getSecretsDb } from "./secretsDb";

interface SecretRow {
  secret: Buffer | null;
}

// AES-256-GCM wrap of a question's secret s_q under the broker's master key
// (config.voterTagMasterKey). Stored blob = iv(12) | tag(16) | ciphertext(32).
// A DB-only dump without the master key yields only this blob; forward secrecy
// still comes from DESTROYING the blob at close (the key can't decrypt a nulled
// row), so a closed question is unlinkable even to a master-key holder (ADR-098).
function masterKey(): Buffer {
  const key = Buffer.from(getSettings().voterTagMasterKey, "base64");
  if (key.length !== 32) {
    throw new Error("HEARME_BROKER_VOTER_TAG_MASTER_KEY must be base64 of 32 bytes (AES-256)");
  }
  return key;
}

function wrap(plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function unwrap(blob: Buffer): Buffer {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// Lazily mint (or fetch) the live secret for a question. Concurrent first-answers
// race on the PK; ON CONFLICT DO NOTHING makes a single random value win, and the
// follow-up SELECT returns whichever won. Returns null only if the row exists but
// its secret was already destroyed (question closed past grace) — the caller must
// then reject rather than store an unkeyed envelope. `closesAt` is copied into the
// row so the reaper stays a single-instance query.
export async function ensureQuestionSecretKey(
  questionId: string,
  closesAt: Date,
): Promise<Buffer | null> {
  const db = getSecretsDb();
  // Mint a fresh s_q and store it WRAPPED. The plaintext s_q never touches the
  // DB; we unwrap whatever row wins the race to derive the tag.
  const wrapped = wrap(randomBytes(32));
  await db`
    INSERT INTO question_secrets (question_id, secret, closes_at)
    VALUES (${questionId}, ${wrapped}, ${closesAt})
    ON CONFLICT (question_id) DO NOTHING
  `;
  const rows = (await db`
    SELECT secret FROM question_secrets WHERE question_id = ${questionId}
  `) as unknown as SecretRow[];
  const blob = rows[0]?.secret ?? null;
  return blob === null ? null : unwrap(blob);
}

// Return the question's secret only if it is still live; null once destroyed
// (or never created). Used by revoke / Self-invalidation, which can only reach
// answers in questions whose secret still exists — the deliberate closed-question
// carve-out (a closed question's aggregate is already published).
export async function getQuestionSecretKeyIfLive(questionId: string): Promise<Buffer | null> {
  const db = getSecretsDb();
  const rows = (await db`
    SELECT secret FROM question_secrets
    WHERE question_id = ${questionId} AND secret IS NOT NULL
  `) as unknown as SecretRow[];
  const blob = rows[0]?.secret ?? null;
  return blob === null ? null : unwrap(blob);
}

// Destroy (null + stamp) every secret whose question closed more than `grace`
// seconds ago. Idempotent and self-pruning; returns how many were destroyed this
// pass. After this, those questions' answers are unlinkable even to the broker.
export async function destroyExpiredQuestionSecrets(graceSeconds: number): Promise<number> {
  const db = getSecretsDb();
  const rows = (await db`
    UPDATE question_secrets
    SET secret = NULL, destroyed_at = now()
    WHERE secret IS NOT NULL
      AND closes_at < now() - make_interval(secs => ${graceSeconds})
    RETURNING question_id
  `) as unknown as Array<{ question_id: string }>;
  return rows.length;
}

interface Logger {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

// Periodic destroyer: the "delete at close" half of ADR-098. Mirrors the
// SelfRevocationListener lifecycle (start/stop, immediate first run). Keyed on
// closes_at + grace, so it needs no question status flip — "closed" is derived.
export class QuestionSecretReaper {
  private graceSeconds: number;
  private intervalMs: number;
  private log: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(opts?: { graceSeconds?: number; intervalSeconds?: number; log?: Logger }) {
    const settings = getSettings();
    this.graceSeconds = opts?.graceSeconds ?? settings.voterTagGraceSeconds;
    this.intervalMs = (opts?.intervalSeconds ?? settings.voterTagReapIntervalSeconds) * 1000;
    this.log = opts?.log ?? console;
  }

  start(): void {
    if (this.timer !== null) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // Don't keep the event loop alive solely for the reaper.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Exposed for tests / shutdown: run one destroy pass.
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const n = await destroyExpiredQuestionSecrets(this.graceSeconds);
      if (n > 0) this.log.info(`question-secret-reaper: destroyed ${n} closed-question secret(s)`);
      return n;
    } catch (err) {
      this.log.error(`question-secret-reaper: pass failed: ${String(err)}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
