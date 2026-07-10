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

const insertStmt = db.prepare(
  `INSERT INTO requests (id, ts, model, quoted_ceiling_usd, status) VALUES (?, ?, ?, ?, 'pending')`,
);
const upstreamOkStmt = db.prepare(
  `UPDATE requests SET prompt_tokens = ?, completion_tokens = ?, upstream_cost_usd = ?, billed_usd = ?, status = 'upstream_ok' WHERE id = ?`,
);
const upstreamErrorStmt = db.prepare(
  `UPDATE requests SET status = 'upstream_error', error = ? WHERE id = ?`,
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
  get(id: string): unknown {
    return db.prepare(`SELECT * FROM requests WHERE id = ?`).get(id);
  },
};
