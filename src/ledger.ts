import Database from "better-sqlite3";
import { cfg } from "./config.js";

/**
 * Every request gets a row at quote time; the row is updated as it moves
 * through upstream call and settlement. This is the gateway's book of record:
 * revenue accounting, spend caps, and (later) cache-design data all read from here.
 */
const db = new Database(cfg.ledgerDb);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    quoted_ceiling_usd REAL NOT NULL,
    upstream_cost_usd REAL,
    billed_usd REAL,
    settled_atomic TEXT,
    payer TEXT,
    tx_hash TEXT,
    cache TEXT NOT NULL DEFAULT 'MISS',
    status TEXT NOT NULL,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);
  CREATE INDEX IF NOT EXISTS idx_requests_payer ON requests(payer);
`);

export interface Summary {
  requests: number;
  settled: number;
  revenue_usd: number;
  settled_upstream_usd: number;
  tokens: number;
  payers: number;
}
export interface Bucket {
  bucket: number;
  requests: number;
  revenue_usd: number;
}
export interface ModelRow {
  model: string;
  requests: number;
  revenue_usd: number;
}
export interface StatusRow {
  status: string;
  count: number;
}
export interface RecentRow {
  id: string;
  ts: number;
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  quoted_ceiling_usd: number;
  billed_usd: number | null;
  settled_atomic: string | null;
  payer: string | null;
  tx_hash: string | null;
  status: string;
  error: string | null;
}

const insertStmt = db.prepare(
  `INSERT INTO requests (id, ts, model, quoted_ceiling_usd, status) VALUES (?, ?, ?, ?, 'pending')`,
);
const upstreamOkStmt = db.prepare(
  `UPDATE requests SET prompt_tokens = ?, completion_tokens = ?, upstream_cost_usd = ?, billed_usd = ?, status = 'upstream_ok' WHERE id = ?`,
);
const upstreamErrorStmt = db.prepare(
  `UPDATE requests SET status = 'upstream_error', error = ? WHERE id = ?`,
);
const cacheHitStmt = db.prepare(
  `UPDATE requests SET prompt_tokens = ?, completion_tokens = ?, upstream_cost_usd = 0,
   billed_usd = ?, cache = 'HIT', status = 'upstream_ok' WHERE id = ?`,
);
const settledStmt = db.prepare(
  `UPDATE requests SET status = 'settled', settled_atomic = ?, payer = ?, tx_hash = ? WHERE id = ?`,
);
const settleFailedStmt = db.prepare(
  `UPDATE requests SET status = 'settle_failed', error = ? WHERE id = ?`,
);
const canceledStmt = db.prepare(
  `UPDATE requests SET status = 'canceled', error = ? WHERE id = ?`,
);
// Pending rows haven't hit upstream yet, so reserve their quoted ceiling.
const spendStmt = db.prepare(
  `SELECT COALESCE(SUM(COALESCE(upstream_cost_usd, quoted_ceiling_usd)), 0) AS spent
   FROM requests WHERE ts > ? AND status != 'upstream_error'`,
);

// Dashboard aggregates. Revenue = what actually moved on-chain (settled_atomic,
// 6-decimal USDC); billed_usd on un-settled rows is money in flight, not revenue.
const summaryStmt = db.prepare(
  `SELECT
     COUNT(*) AS requests,
     SUM(CASE WHEN status = 'settled' THEN 1 ELSE 0 END) AS settled,
     COALESCE(SUM(CASE WHEN status = 'settled' THEN CAST(settled_atomic AS REAL) END), 0) / 1e6 AS revenue_usd,
     COALESCE(SUM(CASE WHEN status = 'settled' THEN upstream_cost_usd END), 0) AS settled_upstream_usd,
     COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens,
     COUNT(DISTINCT payer) AS payers
   FROM requests WHERE ts >= ? AND ts < ?`,
);
const bucketsStmt = db.prepare(
  // CAST, not integer division: better-sqlite3 binds JS numbers as REAL.
  `SELECT CAST(ts / ? AS INTEGER) * ? AS bucket,
     COUNT(*) AS requests,
     COALESCE(SUM(CASE WHEN status = 'settled' THEN CAST(settled_atomic AS REAL) END), 0) / 1e6 AS revenue_usd
   FROM requests WHERE ts >= ? GROUP BY bucket ORDER BY bucket`,
);
const byModelStmt = db.prepare(
  `SELECT model,
     COUNT(*) AS requests,
     COALESCE(SUM(CASE WHEN status = 'settled' THEN CAST(settled_atomic AS REAL) END), 0) / 1e6 AS revenue_usd
   FROM requests WHERE ts >= ? GROUP BY model ORDER BY revenue_usd DESC, requests DESC`,
);
const byStatusStmt = db.prepare(
  `SELECT status, COUNT(*) AS count FROM requests WHERE ts >= ? GROUP BY status`,
);
const recentStmt = db.prepare(
  `SELECT id, ts, model, prompt_tokens, completion_tokens, quoted_ceiling_usd,
          billed_usd, settled_atomic, payer, tx_hash, status, error
   FROM requests WHERE ts >= ? ORDER BY ts DESC LIMIT ?`,
);

export const ledger = {
  insertPending(id: string, model: string, quotedCeilingUsd: number): void {
    insertStmt.run(id, Date.now(), model, quotedCeilingUsd);
  },
  markUpstreamOk(
    id: string,
    promptTokens: number,
    completionTokens: number,
    upstreamCostUsd: number,
    billedUsd: number,
  ): void {
    upstreamOkStmt.run(promptTokens, completionTokens, upstreamCostUsd, billedUsd, id);
  },
  markUpstreamError(id: string, error: string): void {
    upstreamErrorStmt.run(error.slice(0, 500), id);
  },
  markCacheHit(id: string, promptTokens: number, completionTokens: number, billedUsd: number): void {
    cacheHitStmt.run(promptTokens, completionTokens, billedUsd, id);
  },
  markSettled(id: string, settledAtomic: string, payer: string, txHash: string): void {
    settledStmt.run(settledAtomic, payer, txHash, id);
  },
  markSettleFailed(id: string, error: string): void {
    settleFailedStmt.run(error.slice(0, 500), id);
  },
  markCanceled(id: string, reason: string): void {
    canceledStmt.run(reason.slice(0, 500), id);
  },
  upstreamSpendUsdSince(tsMs: number): number {
    return (spendStmt.get(tsMs) as { spent: number }).spent;
  },
  summary(fromMs: number, toMs: number): Summary {
    return summaryStmt.get(fromMs, toMs) as Summary;
  },
  bucketsSince(tsMs: number, bucketMs: number): Bucket[] {
    return bucketsStmt.all(bucketMs, bucketMs, tsMs) as Bucket[];
  },
  byModelSince(tsMs: number): ModelRow[] {
    return byModelStmt.all(tsMs) as ModelRow[];
  },
  byStatusSince(tsMs: number): StatusRow[] {
    return byStatusStmt.all(tsMs) as StatusRow[];
  },
  recentSince(tsMs: number, limit: number): RecentRow[] {
    return recentStmt.all(tsMs, limit) as RecentRow[];
  },
  get(id: string): unknown {
    return db.prepare(`SELECT * FROM requests WHERE id = ?`).get(id);
  },
};
