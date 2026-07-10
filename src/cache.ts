import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { cfg } from "./config.js";

/**
 * Exact-match response cache — the margin tier. A hit costs us nothing
 * upstream and is billed at a fraction of the miss price, so the buyer saves
 * and we keep nearly the whole payment.
 *
 * Correctness rules (non-negotiable):
 * - Exact key match only: SHA-256 over canonical JSON of every parameter that
 *   can affect output. One changed character is a different key.
 * - Private per payer by default; cross-tenant sharing only via explicit
 *   buyer opt-in (X-Cache-Scope: shared) — never leak one agent's responses
 *   to another silently.
 * - Chat requests are cacheable only at temperature 0 (or explicit
 *   X-Cache: force); embeddings are deterministic and always cacheable.
 */

const db = new Database(cfg.ledgerDb);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS response_cache (
    key TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    expires INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    model TEXT NOT NULL,
    scope TEXT NOT NULL,
    response TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    upstream_cost_usd REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cache_expires ON response_cache(expires);
`);

const getStmt = db.prepare(`SELECT * FROM response_cache WHERE key = ? AND expires > ?`);
const putStmt = db.prepare(
  `INSERT OR REPLACE INTO response_cache
   (key, ts, expires, endpoint, model, scope, response, prompt_tokens, completion_tokens, upstream_cost_usd)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const pruneStmt = db.prepare(`DELETE FROM response_cache WHERE expires <= ?`);

/** Deterministic serialization: objects by sorted key, arrays in order. */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`);
  return `{${entries.join(",")}}`;
}

export type CacheScope = "private" | "shared";

export function cacheKey(
  endpoint: string,
  params: Record<string, unknown>,
  scope: CacheScope,
  payer: string | undefined,
): string {
  const namespace = scope === "private" ? (payer ?? "").toLowerCase() : "shared";
  return createHash("sha256")
    .update(`${endpoint}|${namespace}|${canonicalStringify(params)}`)
    .digest("hex");
}

export interface CachedResponse {
  response: Record<string, unknown>;
  promptTokens: number;
  completionTokens: number;
  upstreamCostUsd: number;
  ageMs: number;
}

const MAX_CACHEABLE_BYTES = 1_000_000;

export const responseCache = {
  get(key: string): CachedResponse | undefined {
    const row = getStmt.get(key, Date.now()) as
      | {
          response: string;
          prompt_tokens: number;
          completion_tokens: number;
          upstream_cost_usd: number;
          ts: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      response: JSON.parse(row.response) as Record<string, unknown>,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      upstreamCostUsd: row.upstream_cost_usd,
      ageMs: Date.now() - row.ts,
    };
  },
  put(
    key: string,
    endpoint: string,
    model: string,
    scope: CacheScope,
    response: Record<string, unknown>,
    promptTokens: number,
    completionTokens: number,
    upstreamCostUsd: number,
    ttlMs: number,
  ): void {
    const serialized = JSON.stringify(response);
    if (serialized.length > MAX_CACHEABLE_BYTES) return;
    const now = Date.now();
    putStmt.run(
      key,
      now,
      now + ttlMs,
      endpoint,
      model,
      scope,
      serialized,
      promptTokens,
      completionTokens,
      upstreamCostUsd,
    );
  },
  pruneExpired(): number {
    return pruneStmt.run(Date.now()).changes;
  },
};

// Hourly prune keeps the volume bounded without a separate job.
setInterval(() => responseCache.pruneExpired(), 3600_000).unref();
