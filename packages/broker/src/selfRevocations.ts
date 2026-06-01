// Self on-chain invalidation listener.
//
// The broker verifies Self once at registration, so it must also consume Self's
// later on-chain invalidation/update signal. This worker polls a configured Self
// contract event and applies invalidations in the broker DB: mark
// registrations.revoked_at, remove that nullifier's accepted envelopes, and
// recompute affected aggregates. The exact Self event ABI is configuration, not
// code. Mirrors self_revocations.py.

import { type Settings, getSettings } from "./config";
import type { Db } from "./db";
import * as q from "./queries";

export class SelfRevocationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelfRevocationConfigError";
  }
}

function cleanHex(value: string): string {
  if (typeof value !== "string") throw new Error("expected hex string");
  const v = value.toLowerCase();
  return v.startsWith("0x") ? v : `0x${v}`;
}

function hexToIntString(value: string): string {
  return BigInt(cleanHex(value)).toString();
}

// Likely DB forms for a Self nullifier emitted as bytes32/uint256. The bridge
// stores whatever discloseOutput.nullifier returns; chain logs usually emit a
// uint256/bytes32. Matching a small candidate set covers decimal, 0x-hex, and
// "self:"-prefixed forms.
export function nullifierCandidates(raw: string): string[] {
  const h = cleanHex(raw);
  let stripped = "0x" + h.slice(2).replace(/^0+/, "");
  if (stripped === "0x") stripped = "0x0";
  const decimal = hexToIntString(h);
  const out = [h, stripped, decimal, `self:${h}`, `self:${stripped}`, `self:${decimal}`];
  const seen = new Set<string>();
  return out.filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
}

// Extract a nullifier-like 32-byte value from an eth_getLogs entry.
export function extractNullifierFromLog(
  entry: { topics?: string[]; data?: unknown },
  topicIndex: number,
  dataWordIndex: number,
): string | null {
  const topics = entry.topics ?? [];
  if (topicIndex >= 0) {
    if (topicIndex >= topics.length) return null;
    return cleanHex(topics[topicIndex]);
  }
  if (dataWordIndex < 0) return null;
  const data = entry.data;
  if (typeof data !== "string") return null;
  const body = data.startsWith("0x") ? data.slice(2) : data;
  const start = dataWordIndex * 64;
  const word = body.slice(start, start + 64);
  if (word.length !== 64) return null;
  return `0x${word.toLowerCase()}`;
}

export interface ChainLog {
  blockNumber: number;
  logIndex: number;
  txHash: string;
  nullifierRaw: string;
}

interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export class SelfRevocationListener {
  private db: Db;
  private settings: Settings;
  private log: Logger;
  private stopped = false;
  private task: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(opts: { db: Db; settings?: Settings; log?: Logger }) {
    this.db = opts.db;
    this.settings = opts.settings ?? getSettings();
    this.log = opts.log ?? console;
  }

  validateConfig(): void {
    const s = this.settings;
    if (!s.selfRevocationListenerEnabled) return;
    const missing = Object.entries({
      HEARME_BROKER_SELF_REVOCATION_RPC_URL: s.selfRevocationRpcUrl,
      HEARME_BROKER_SELF_REVOCATION_CONTRACT_ADDRESS: s.selfRevocationContractAddress,
      HEARME_BROKER_SELF_REVOCATION_EVENT_TOPIC: s.selfRevocationEventTopic,
    })
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new SelfRevocationConfigError(
        "Self revocation listener enabled but missing " + missing.join(", "),
      );
    }
    if (
      s.selfRevocationNullifierTopicIndex < 0 &&
      s.selfRevocationNullifierDataWordIndex < 0
    ) {
      throw new SelfRevocationConfigError(
        "configure either nullifier_topic_index or nullifier_data_word_index",
      );
    }
  }

  start(): void {
    this.validateConfig();
    if (!this.settings.selfRevocationListenerEnabled) {
      this.log.info("Self revocation listener disabled");
      return;
    }
    if (this.task === null) this.task = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.wake) this.wake();
    if (this.task) await this.task;
  }

  private sleep(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, seconds * 1000);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    const resp = await fetch(this.settings.selfRevocationRpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!resp.ok) throw new Error(`${method} HTTP ${resp.status}`);
    const body = (await resp.json()) as { result?: unknown; error?: unknown };
    if (body.error) throw new Error(`${method} failed: ${JSON.stringify(body.error)}`);
    return body.result;
  }

  async latestFinalBlock(): Promise<number> {
    const headHex = (await this.rpc("eth_blockNumber", [])) as string;
    const head = parseInt(headHex, 16);
    return Math.max(0, head - Math.max(0, this.settings.selfRevocationConfirmations));
  }

  async fetchLogs(fromBlock: number, toBlock: number): Promise<ChainLog[]> {
    const s = this.settings;
    const result = (await this.rpc("eth_getLogs", [
      {
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
        address: s.selfRevocationContractAddress,
        topics: [cleanHex(s.selfRevocationEventTopic)],
      },
    ])) as Array<{
      topics?: string[];
      data?: unknown;
      blockNumber: string;
      logIndex: string;
      transactionHash: string;
    }>;
    const logs: ChainLog[] = [];
    for (const entry of result ?? []) {
      const raw = extractNullifierFromLog(
        entry,
        s.selfRevocationNullifierTopicIndex,
        s.selfRevocationNullifierDataWordIndex,
      );
      if (raw === null) {
        this.log.warn("Self invalidation log without configured nullifier", entry);
        continue;
      }
      logs.push({
        blockNumber: parseInt(entry.blockNumber, 16),
        logIndex: parseInt(entry.logIndex, 16),
        txHash: String(entry.transactionHash),
        nullifierRaw: raw,
      });
    }
    logs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    return logs;
  }

  async applyLog(item: ChainLog): Promise<q.InvalidationResult | null> {
    const candidates = nullifierCandidates(item.nullifierRaw);
    const result = await q.invalidateFirstMatchingRegistrationAndVotes(this.db, {
      candidates,
      source: "self_onchain",
      chainId: this.settings.selfRevocationChainId,
      blockNumber: item.blockNumber,
      logIndex: item.logIndex,
      txHash: item.txHash,
    });
    if (result !== null) {
      this.log.info(
        `applied Self invalidation block=${item.blockNumber} log=${item.logIndex} ` +
          `envelopes=${result.deletedEnvelopes} questions=${result.affectedQuestions}`,
      );
    }
    return result;
  }

  async pollOnce(): Promise<number> {
    const s = this.settings;
    const cursor = await q.getSelfChainCursor(this.db, s.selfRevocationCursorName);
    const fromBlock = cursor !== null ? cursor + 1 : s.selfRevocationFromBlock;
    const toBlock = await this.latestFinalBlock();
    if (toBlock < fromBlock) return 0;

    const logs = await this.fetchLogs(fromBlock, toBlock);
    for (const item of logs) await this.applyLog(item);

    await q.upsertSelfChainCursor(this.db, { name: s.selfRevocationCursorName, lastBlock: toBlock });
    return logs.length;
  }

  async run(): Promise<void> {
    this.log.info("Self revocation listener started");
    while (!this.stopped) {
      try {
        const count = await this.pollOnce();
        if (count) this.log.info(`processed ${count} Self invalidation log(s)`);
      } catch (exc) {
        this.log.error("Self revocation listener poll failed", exc);
      }
      if (this.stopped) break;
      await this.sleep(this.settings.selfRevocationPollIntervalSeconds);
    }
    this.log.info("Self revocation listener stopped");
  }
}
