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
export const EMBEDDINGS_PATH = "/v1/embeddings";

export function publicBase(): string {
  return (cfg.publicBaseUrl ?? `http://localhost:${cfg.port}`).replace(/\/$/, "");
}

export function publicResourceUrl(): string {
  return `${publicBase()}${RESOURCE_PATH}`;
}

export function publicEmbeddingsUrl(): string {
  return `${publicBase()}${EMBEDDINGS_PATH}`;
}

/**
 * The facilitator rejects payments whose resource.description exceeds 500
 * chars (verified against CDP 2026-07-11: 521 chars -> schema 400 on every
 * verify, i.e. a total outage). Fail at boot, never in production.
 */
function assertDescriptionLength(text: string, name: string): string {
  if (text.length > 500) {
    throw new Error(`${name} is ${text.length} chars — facilitator limit is 500`);
  }
  return text;
}

// Bazaar semantic search ranks on this text (<=500 chars): task verbs agents
// query for, current model names, and the price hooks (markup + cache).
export const DESCRIPTION = assertDescriptionLength(
  "LLM inference API for AI agents: OpenAI-compatible chat completions paid " +
    "per request in USDC on Base. No account or API key. Summarize, classify, " +
    "extract, translate, generate and chat with " +
    `${Object.keys(MODELS).slice(0, 5).join(", ")} and more. Misses billed at ` +
    `cost + ${Math.round((cfg.markup - 1) * 100)}% on actual token usage (upto scheme); deterministic ` +
    `repeats (temperature 0) are cache hits billed at ${Math.round(cfg.hitMultiplierPrivate * 100)}% of provider ` +
    "price — loops get cheaper automatically. From $0.001/call, standard OpenAI POST format.",
  "DESCRIPTION",
);

export const EMBEDDINGS_DESCRIPTION = assertDescriptionLength(
  "Text embeddings API for AI agents: OpenAI-compatible /v1/embeddings paid " +
    "per request in USDC on Base — no account or API key. Embed documents for " +
    "RAG, semantic search, clustering, deduplication with text-embedding-3-small " +
    "or text-embedding-3-large. Embeddings are deterministic, so repeated texts " +
    `hit our cache and bill at ${Math.round(cfg.hitMultiplierPrivate * 100)}% of provider price — ` +
    `re-embedding a corpus costs roughly half. Misses at cost + ` +
    `${Math.round((cfg.markup - 1) * 100)}%, from $0.001/call. Standard OpenAI POST format.`,
  "EMBEDDINGS_DESCRIPTION",
);

export const EMBEDDINGS_TAGS = [
  "embeddings",
  "rag",
  "semantic-search",
  "vector",
  "openai",
  "text-embedding-3-small",
  "ai",
];

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

export const EMBEDDINGS_INPUT_SCHEMA = {
  properties: {
    model: {
      type: "string",
      enum: ["text-embedding-3-small", "text-embedding-3-large"],
      description: "Embedding model",
    },
    input: {
      description: "String or array of strings to embed",
    },
    dimensions: {
      type: "number",
      description: "Optional output dimensionality (model-dependent)",
    },
  },
  required: ["model", "input"],
};

export const EMBEDDINGS_INPUT_EXAMPLE = {
  model: "text-embedding-3-small",
  input: "The quick brown fox jumps over the lazy dog",
};

export const EMBEDDINGS_OUTPUT_EXAMPLE = {
  object: "list",
  data: [{ object: "embedding", index: 0, embedding: [0.0023, -0.0091, 0.0154] }],
  model: "text-embedding-3-small",
  usage: { prompt_tokens: 9, total_tokens: 9 },
};

export function embeddingsDiscoveryExtension(): Record<string, unknown> {
  return declareDiscoveryExtension({
    bodyType: "json",
    input: EMBEDDINGS_INPUT_EXAMPLE,
    inputSchema: EMBEDDINGS_INPUT_SCHEMA,
    output: { example: EMBEDDINGS_OUTPUT_EXAMPLE },
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
