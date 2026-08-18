export type Question = {
  question_id: string;
  text: string;
  topic?: string;
  options: string[];
  closes_at?: string;
};

export type IdentityCredential = {
  delegation_token: Record<string, unknown>;
  agent_seed_b64: string;
  /** Broker Self nullifier; used only as the server-side account subject. */
  unique_identifier?: string;
};

export interface IdentityProvider {
  begin(userId: string): Promise<{ authorizationUrl: string; state: string }>;
  /** The proof is collected by the Self callback, never passed through ChatGPT. */
  complete(userId: string, state: string): Promise<IdentityCredential>;
}

export interface ChorumBroker {
  latestQuestions(userId: string): Promise<Question[]>;
  review(userId: string): Promise<unknown>;
}

export interface RustSigner {
  submit(userId: string, credential: IdentityCredential, questionId: string, answer: string | null): Promise<{ accepted: boolean; reason?: string }>;
  revoke(userId: string, credential: IdentityCredential, questionId: string): Promise<{ accepted: boolean; reason?: string }>;
  revokeAll(userId: string, credential: IdentityCredential): Promise<void>;
  review(userId: string, credential: IdentityCredential): Promise<unknown>;
}
