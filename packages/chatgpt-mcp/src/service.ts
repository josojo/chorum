import type { ChorumBroker, IdentityCredential, IdentityProvider, RustSigner, Question } from "./types.js";
import { EncryptedUserStore } from "./store.js";

export class ChorumService {
  constructor(
    private readonly store: EncryptedUserStore,
    private readonly identity: IdentityProvider,
    private readonly broker: ChorumBroker,
    private readonly signer: RustSigner,
  ) {}

  async authorize(userId: string, automatic: boolean, history: boolean) {
    if (!automatic || !history) throw new Error("explicit consent for automatic voting and history use is required");
    const pending = await this.identity.begin(userId);
    await this.store.put(userId, { consentAutomaticVoting: true, consentHistoryUse: true, identity: pending });
    return { status: "identity_authorization_required", authorization_url: pending.authorizationUrl };
  }

  async completeIdentity(userId: string, state: string) {
    const current = await this.store.get(userId);
    if (!current?.consentAutomaticVoting || current.identity?.state !== state) throw new Error("identity authorization is missing or expired");
    const credential = await this.identity.complete(userId, state);
    await this.store.put(userId, { ...current, identity: undefined, credential });
    return { status: "authorized" };
  }

  async latestQuestions(userId: string): Promise<Question[]> {
    await this.authorized(userId);
    return this.broker.latestQuestions(userId);
  }

  async vote(userId: string, questionId: string, answer: string | null) {
    const credential = await this.authorized(userId);
    return this.signer.submit(userId, credential, questionId, answer);
  }

  async review(userId: string) {
    const credential = await this.authorized(userId);
    return this.signer.review(userId, credential);
  }

  async revoke(userId: string, questionId: string) {
    const credential = await this.authorized(userId);
    return this.signer.revoke(userId, credential, questionId);
  }

  async reset(userId: string) {
    const current = await this.store.get(userId);
    if (current?.credential) await this.signer.revokeAll(userId, current.credential);
    await this.store.delete(userId);
    return { status: "reset" };
  }

  private async authorized(userId: string): Promise<IdentityCredential> {
    const current = await this.store.get(userId);
    if (!current?.consentAutomaticVoting || !current.consentHistoryUse || !current.credential) throw new Error("Chorum authorization is required");
    return current.credential;
  }
}
