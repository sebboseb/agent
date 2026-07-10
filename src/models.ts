import { cfg } from "./config.js";

/**
 * Upstream price registry, USD per 1M tokens.
 * These MUST be kept in sync with https://platform.openai.com/docs/pricing —
 * a stale price here is money leaking on every call.
 */
export interface ModelInfo {
  inputPerMtok: number;
  outputPerMtok: number;
}

export const MODELS: Record<string, ModelInfo> = {
  // Current generation (verified against the official pricing page 2026-07-10)
  "gpt-5.4-nano": { inputPerMtok: 0.2, outputPerMtok: 1.25 },
  "gpt-5.4-mini": { inputPerMtok: 0.75, outputPerMtok: 4.5 },
  "gpt-5.4": { inputPerMtok: 2.5, outputPerMtok: 15 },
  "gpt-5.5": { inputPerMtok: 5, outputPerMtok: 30 },
  // Legacy: unlisted on the pricing page but still served; agents pinned to
  // these still find us. Prices are the last published rates.
  "gpt-4o-mini": { inputPerMtok: 0.15, outputPerMtok: 0.6 },
  "gpt-4o": { inputPerMtok: 2.5, outputPerMtok: 10 },
  "gpt-4.1-mini": { inputPerMtok: 0.4, outputPerMtok: 1.6 },
  "gpt-4.1": { inputPerMtok: 2, outputPerMtok: 8 },
};

export interface ChatBody {
  model?: string;
  messages?: unknown;
  tools?: unknown;
  max_tokens?: number;
  max_completion_tokens?: number;
  [key: string]: unknown;
}

/** Output-token budget we will actually send upstream (and therefore quote for). */
export function effectiveMaxTokens(body: ChatBody): number {
  const requested = body.max_tokens ?? body.max_completion_tokens ?? cfg.defaultMaxTokens;
  return Math.min(Math.max(1, Math.floor(requested)), cfg.hardMaxTokens);
}

/**
 * Ceiling quoted in the 402 (the `upto` authorization maximum).
 * Input tokens are estimated at 1 token per 3 characters — deliberately
 * pessimistic (English averages ~4 chars/token) so actual usage stays
 * below the authorized ceiling. Settlement bills actual usage.
 */
export function estimateCeilingUsd(body: ChatBody): number {
  const model = body.model ? MODELS[body.model] : undefined;
  if (!model) return 0.001; // handler will 400 before any charge happens
  const inputChars =
    JSON.stringify(body.messages ?? "").length + JSON.stringify(body.tools ?? "").length;
  const inputTokens = Math.ceil(inputChars / 3);
  const outputTokens = effectiveMaxTokens(body);
  const usd =
    ((inputTokens * model.inputPerMtok + outputTokens * model.outputPerMtok) / 1_000_000) *
    cfg.markup;
  // Quote floor must cover the minimum bill, or settlement would exceed the authorization.
  return Math.max(usd, cfg.minBillUsd, 0.001);
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

export function actualCostUsd(model: ModelInfo, usage: Usage): number {
  return (
    (usage.prompt_tokens * model.inputPerMtok + usage.completion_tokens * model.outputPerMtok) /
    1_000_000
  );
}
