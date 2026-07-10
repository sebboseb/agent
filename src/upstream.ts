import { cfg } from "./config.js";
import { effectiveMaxTokens, type ChatBody, type EmbeddingsBody, type Usage } from "./models.js";

/**
 * Fields forwarded upstream. Everything else is dropped — notably `stream`
 * (settlement needs the complete response) and `n` (multiple choices would
 * blow past the quoted output ceiling).
 */
const FORWARDED_FIELDS = [
  "model",
  "messages",
  "temperature",
  "top_p",
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "response_format",
  "tools",
  "tool_choice",
  "seed",
  "user",
  "logit_bias",
  "logprobs",
  "top_logprobs",
] as const;

export class UpstreamError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`upstream ${status}: ${body.slice(0, 300)}`);
  }
}

export interface UpstreamResult {
  json: Record<string, unknown>;
  usage: Usage;
}

export async function callUpstream(body: ChatBody): Promise<UpstreamResult> {
  const forwarded: Record<string, unknown> = {};
  for (const field of FORWARDED_FIELDS) {
    if (body[field] !== undefined) forwarded[field] = body[field];
  }
  // GPT-5.x models reject the deprecated `max_tokens`; `max_completion_tokens`
  // is accepted across the lineup. Buyers may send either — we normalize.
  delete forwarded.max_tokens;
  forwarded.max_completion_tokens = effectiveMaxTokens(body);
  forwarded.stream = false;

  const res = await fetch(`${cfg.openaiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.openaiApiKey}`,
    },
    body: JSON.stringify(forwarded),
  });
  if (!res.ok) {
    throw new UpstreamError(res.status, await res.text());
  }
  const json = (await res.json()) as Record<string, unknown>;
  const usage = json.usage as Usage | undefined;
  if (
    !usage ||
    typeof usage.prompt_tokens !== "number" ||
    typeof usage.completion_tokens !== "number"
  ) {
    throw new UpstreamError(502, "upstream response missing usage — cannot bill");
  }
  return { json, usage };
}

const EMBEDDINGS_FORWARDED = ["model", "input", "dimensions", "encoding_format", "user"] as const;

export interface EmbeddingsUpstreamResult {
  json: Record<string, unknown>;
  usage: { prompt_tokens: number };
}

export async function callEmbeddingsUpstream(body: EmbeddingsBody): Promise<EmbeddingsUpstreamResult> {
  const forwarded: Record<string, unknown> = {};
  for (const field of EMBEDDINGS_FORWARDED) {
    if (body[field] !== undefined) forwarded[field] = body[field];
  }
  const res = await fetch(`${cfg.openaiBaseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.openaiApiKey}`,
    },
    body: JSON.stringify(forwarded),
  });
  if (!res.ok) {
    throw new UpstreamError(res.status, await res.text());
  }
  const json = (await res.json()) as Record<string, unknown>;
  const usage = json.usage as { prompt_tokens?: number } | undefined;
  if (!usage || typeof usage.prompt_tokens !== "number") {
    throw new UpstreamError(502, "upstream response missing usage — cannot bill");
  }
  return { json, usage: { prompt_tokens: usage.prompt_tokens } };
}
