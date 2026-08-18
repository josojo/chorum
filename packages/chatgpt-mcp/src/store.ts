import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { IdentityCredential } from "./types.js";

export type UserRecord = {
  consentAutomaticVoting: boolean;
  consentHistoryUse: boolean;
  identity?: { state: string; authorizationUrl: string };
  credential?: IdentityCredential;
};

/** Encrypted-at-rest store. The master key must come from a secret manager in production. */
export class EncryptedUserStore {
  constructor(private readonly path: string, private readonly masterKey: Buffer) {
    if (masterKey.length !== 32) throw new Error("CHORUM_MCP_MASTER_KEY must be 32 bytes");
  }

  async get(userId: string): Promise<UserRecord | undefined> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as { iv: string; tag: string; data: string };
      const decipher = createDecipheriv("aes-256-gcm", this.masterKey, Buffer.from(raw.iv, "base64"));
      decipher.setAuthTag(Buffer.from(raw.tag, "base64"));
      const plain = Buffer.concat([decipher.update(Buffer.from(raw.data, "base64")), decipher.final()]);
      const all = JSON.parse(plain.toString("utf8")) as Record<string, UserRecord>;
      return all[userId];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("credential store could not be opened");
    }
  }

  async put(userId: string, value: UserRecord): Promise<void> {
    const all = await this.readAll();
    all[userId] = value;
    await this.writeAll(all);
  }

  async delete(userId: string): Promise<void> {
    const all = await this.readAll();
    delete all[userId];
    await this.writeAll(all);
  }

  async move(fromUserId: string, toUserId: string): Promise<void> {
    if (fromUserId === toUserId) return;
    const all = await this.readAll();
    const value = all[fromUserId];
    if (!value) throw new Error("credential store record is missing");
    all[toUserId] = value;
    delete all[fromUserId];
    await this.writeAll(all);
  }

  private async readAll(): Promise<Record<string, UserRecord>> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as { iv: string; tag: string; data: string };
      const decipher = createDecipheriv("aes-256-gcm", this.masterKey, Buffer.from(raw.iv, "base64"));
      decipher.setAuthTag(Buffer.from(raw.tag, "base64"));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(raw.data, "base64")), decipher.final()]).toString("utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("credential store could not be opened");
    }
  }

  private async writeAll(all: Record<string, UserRecord>): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(all)), cipher.final()]);
    const payload = JSON.stringify({ iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${process.pid}`;
    await writeFile(temporary, payload, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }
}
