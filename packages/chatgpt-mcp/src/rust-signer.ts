import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { IdentityCredential, RustSigner } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Server-side bridge to the existing Rust CLI. Credentials are decrypted only
 * for the duration of one signing call, written 0600 into a private temporary
 * root, and removed afterwards. stdout/stderr are never returned or logged.
 */
export class RustCliSigner implements RustSigner {
  constructor(private readonly binary = "chorum-skill", private readonly brokerUrl = process.env.CHORUM_MCP_BROKER_URL) {}

  async submit(_userId: string, credential: IdentityCredential, questionId: string, answer: string | null) {
    return this.run(credential, answer === null ? ["submit-no-signal", "--question-id", questionId] : ["submit-answer", "--question-id", questionId, "--answer", answer]);
  }

  async revoke(_userId: string, credential: IdentityCredential, questionId: string) {
    return this.run(credential, ["revoke-answer", "--question-id", questionId]);
  }

  async revokeAll(userId: string, credential: IdentityCredential) {
    const review = await this.review(userId, credential);
    const answers = (review as { answers?: Array<{ question_id?: string }> }).answers ?? [];
    for (const answer of answers) if (answer.question_id) await this.revoke(userId, credential, answer.question_id);
  }

  async review(_userId: string, credential: IdentityCredential) {
    return this.run(credential, ["review-answers"]);
  }

  private async run(credential: IdentityCredential, args: string[]) {
    const root = await mkdtemp(join(tmpdir(), "chorum-sign-"));
    try {
      await writeFile(join(root, "delegation.token"), JSON.stringify(credential.delegation_token), { mode: 0o600 });
      await writeFile(join(root, "agent_key"), Buffer.from(credential.agent_seed_b64, "base64"), { mode: 0o600 });
      const { stdout } = await execFileAsync(this.binary, args, {
        env: { ...process.env, CHORUM_SKILL_ROOT_DIR: root, ...(this.brokerUrl ? { CHORUM_SKILL_BROKER_URL: this.brokerUrl } : {}) },
        maxBuffer: 1024 * 1024,
      });
      try { return JSON.parse(stdout) as { accepted: boolean; reason?: string; answers?: unknown[] }; }
      catch { throw new Error("Rust signing command returned invalid output"); }
    } catch {
      throw new Error("Chorum signing operation failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
