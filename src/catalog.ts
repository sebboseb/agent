import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { cfg } from "./config.js";
import { MODELS } from "./models.js";

/**
 * Single source of truth for how this service describes itself — consumed by
 * the paid route config (Bazaar indexing via the facilitator) and by the
 * self-hosted discovery surfaces (/.well-known/x402.json, llms.txt, openapi.json).
 */

export const SERVICE_NAME = "x402 inference gateway";

export const RESOURCE_PATH = "/v1/chat/completions";

export function publicResourceUrl(): string {
  const base = (cfg.publicBaseUrl ?? `http://localhost:${cfg.port}`).replace(/\/$/, "");
  return `${base}${RESOURCE_PATH}`;
}

// Bazaar semantic search ranks on this text (<=500 chars): task verbs agents
// query for, current model names, and the price hook.
export const DESCRIPTION =
  "LLM inference API for AI agents: OpenAI-compatible chat completions paid " +
  "per request in USDC on Base — no account or API key needed. Summarize, " +
  "classify, extract, translate, generate text and chat with " +
  `${Object.keys(MODELS).slice(0, 5).join(", ")} and more. Lowest markup on ` +
  `x402: upstream cost + ${Math.round((cfg.markup - 1) * 100)}%, billed on ` +
  "actual token usage (upto scheme), from $0.001 per call. Standard OpenAI " +
  "POST format — point your existing client at this URL.";

export const TAGS = [
  "inference",
  "llm",
  "openai",
  "chat-completions",
  "gpt-5.4",
  "gpt-5.4-nano",
  "gpt-4o-mini",
  "summarization",
  "classification",
  "text-generation",
  "ai",
];

export const INPUT_SCHEMA = {
  properties: {
    model: {
      type: "string",
      enum: Object.keys(MODELS),
      description: "Upstream model to run",
    },
    messages: {
      type: "array",
      description: "OpenAI chat messages array",
    },
    max_tokens: {
      type: "number",
      description: "Output cap; the authorized payment ceiling scales with it",
    },
  },
  required: ["model", "messages"],
};

export const INPUT_EXAMPLE = {
  model: "gpt-5.4-nano",
  messages: [{ role: "user", content: "Summarize this in one sentence: ..." }],
  max_tokens: 256,
  temperature: 0,
};

export const OUTPUT_EXAMPLE = {
  id: "chatcmpl-abc123",
  object: "chat.completion",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "One-sentence summary." },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 42, completion_tokens: 12, total_tokens: 54 },
};

/** Bazaar discovery declaration for the paid route (facilitator-side indexing). */
export function discoveryExtension(): Record<string, unknown> {
  return declareDiscoveryExtension({
    bodyType: "json",
    input: INPUT_EXAMPLE,
    inputSchema: INPUT_SCHEMA,
    output: { example: OUTPUT_EXAMPLE },
  });
}

/**
 * Representative payment requirements for self-hosted discovery. The real
 * quote is dynamic (derived from max_tokens at request time); this shows the
 * minimum so price-filtering agents see our floor.
 */
export function representativeAccepts(): Record<string, unknown>[] {
  return [
    {
      scheme: "upto",
      network: cfg.network,
      amount: String(Math.round(cfg.minBillUsd * 1_000_000)),
      asset: cfg.usdcAddress,
      payTo: cfg.payTo,
      maxTimeoutSeconds: 300,
      extra: {
        name: "USD Coin",
        version: "2",
        assetTransferMethod: "permit2",
        note: "amount shown is the minimum; the 402 quotes a ceiling derived from max_tokens and settlement bills actual usage at upstream cost x " + cfg.markup,
      },
    },
  ];
}
