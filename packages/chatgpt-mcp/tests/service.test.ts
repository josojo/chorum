import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncryptedUserStore } from "../src/store.js";
import { ChorumService } from "../src/service.js";

test("requires both explicit consents and keeps credentials encrypted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chorum-mcp-"));
  const path = join(dir, "users.enc");
  const store = new EncryptedUserStore(path, Buffer.alloc(32, 7));
  const identity = { begin: async () => ({ authorizationUrl: "https://self.test/a", state: "s1" }), complete: async () => ({ delegation_token: { secret: "token" }, agent_seed_b64: "seed" }) };
  const broker = { latestQuestions: async () => [{ question_id: "q1", text: "Tea?", options: ["yes", "no"] }], review: async () => ({ answers: [] }) };
  const signer = { submit: async (_u: string, _c: unknown, _q: string, answer: string | null) => ({ accepted: answer === null, reason: answer === null ? "abstained" : "ok" }), revoke: async () => ({ accepted: true }), revokeAll: async () => {}, review: async () => ({ answers: [] }) };
  const service = new ChorumService(store, identity, broker, signer);
  await assert.rejects(service.authorize("u1", true, false));
  assert.deepEqual(await service.authorize("u1", true, true), { status: "identity_authorization_required", authorization_url: "https://self.test/a" });
  await service.completeIdentity("u1", "s1");
  assert.deepEqual(await service.latestQuestions("u1"), [{ question_id: "q1", text: "Tea?", options: ["yes", "no"] }]);
  assert.deepEqual(await service.vote("u1", "q1", null), { accepted: true, reason: "abstained" });
  assert.equal((await readFile(path, "utf8")).includes("token"), false);
  await service.reset("u1");
  await assert.rejects(service.latestQuestions("u1"));
});
