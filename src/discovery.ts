import { Hono } from "hono";
import { cfg } from "./config.js";
import { MODELS } from "./models.js";
import {
  SERVICE_NAME,
  DESCRIPTION,
  TAGS,
  INPUT_SCHEMA,
  INPUT_EXAMPLE,
  OUTPUT_EXAMPLE,
  EMBEDDINGS_DESCRIPTION,
  EMBEDDINGS_TAGS,
  EMBEDDINGS_INPUT_SCHEMA,
  EMBEDDINGS_INPUT_EXAMPLE,
  EMBEDDINGS_OUTPUT_EXAMPLE,
  discoveryExtension,
  embeddingsDiscoveryExtension,
  representativeAccepts,
  publicResourceUrl,
  publicEmbeddingsUrl,
} from "./catalog.js";

/**
 * Self-hosted discovery surfaces (all unpaid — mounted before the payment
 * middleware). The Bazaar is the primary index, but crawlers, LLM-driven
 * integrators, and other x402 directories read these directly:
 *   GET /.well-known/x402.json  — machine-usable manifest (Bazaar-schema style)
 *   GET /llms.txt               — llmstxt.org doc for LLM-assisted integration
 *   GET /openapi.json           — OpenAPI 3.1 with the 402 flow documented
 */

export const discovery = new Hono();

function manifest() {
  const base = (cfg.publicBaseUrl ?? `http://localhost:${cfg.port}`).replace(/\/$/, "");
  return {
    x402Version: 2,
    provider: SERVICE_NAME,
    homepage: base,
    openapi_url: `${base}/openapi.json`,
    llms_txt: `${base}/llms.txt`,
    facilitator: cfg.facilitatorUrl,
    resources: [
      {
        resource: publicResourceUrl(),
        type: "http",
        method: "POST",
        description: DESCRIPTION,
        serviceName: SERVICE_NAME,
        tags: TAGS,
        accepts: representativeAccepts(),
        extensions: discoveryExtension(),
      },
      {
        resource: publicEmbeddingsUrl(),
        type: "http",
        method: "POST",
        description: EMBEDDINGS_DESCRIPTION,
        serviceName: SERVICE_NAME,
        tags: EMBEDDINGS_TAGS,
        accepts: representativeAccepts(),
        extensions: embeddingsDiscoveryExtension(),
      },
    ],
  };
}

discovery.get("/.well-known/x402.json", (c) => c.json(manifest()));
discovery.get("/.well-known/x402", (c) => c.json(manifest()));

discovery.get("/llms.txt", (c) => {
  const base = (cfg.publicBaseUrl ?? `http://localhost:${cfg.port}`).replace(/\/$/, "");
  const modelTable = Object.entries(MODELS)
    .map(([name, m]) => `- ${name}: $${m.inputPerMtok}/M input, $${m.outputPerMtok}/M output tokens (+${Math.round((cfg.markup - 1) * 100)}%)`)
    .join("\n");
  return c.text(`# ${SERVICE_NAME}

> ${DESCRIPTION}

Pay-per-request LLM inference over the x402 payment protocol. No account, no
API key: send a standard OpenAI chat completions request, receive an HTTP 402
quote, pay in USDC on Base (eip155:8453), get the completion. The \`upto\`
scheme authorizes a ceiling derived from max_tokens; settlement bills actual
token usage at upstream cost + ${Math.round((cfg.markup - 1) * 100)}% (minimum $${cfg.minBillUsd}/call). Every
response carries X-Billed-Usd and X-Quoted-Ceiling-Usd billing-transparency
headers. Streaming and n>1 are not supported.

## Endpoints

- POST ${base}/v1/chat/completions — standard OpenAI request body
- POST ${base}/v1/embeddings — standard OpenAI embeddings body (text-embedding-3-small/-large)

## Cache — repeats cost roughly half

Deterministic requests (chat at temperature 0; all embeddings) are cached
exact-match, private per payer. A repeat identical request is a cache HIT
billed at ${Math.round(cfg.hitMultiplierPrivate * 100)}% of provider price instead of cost + ${Math.round((cfg.markup - 1) * 100)}%. Opt into the
cross-tenant pool with X-Cache-Scope: shared for ${Math.round(cfg.hitMultiplierShared * 100)}%. Controls:
X-Cache: bypass|force, X-Cache-TTL: seconds. Receipt: X-Cache: HIT|MISS header.

## Models (USD per 1M tokens, before markup)

${modelTable}
- text-embedding-3-small: $0.02/M input tokens (+${Math.round((cfg.markup - 1) * 100)}%)
- text-embedding-3-large: $0.13/M input tokens (+${Math.round((cfg.markup - 1) * 100)}%)

## Integration

- [OpenAPI 3.1 spec](${base}/openapi.json): request/response schemas and the 402 flow
- [x402 manifest](${base}/.well-known/x402.json): machine-usable payment requirements
- [Service info](${base}/): pricing table and quickstart code
- Pay with any x402 v2 client, e.g. @x402/fetch + @x402/evm (UptoEvmScheme):
  wrap fetch, point it at the endpoint, and the 402/pay/retry loop is automatic.

## Optional

- [GitHub](https://github.com/sebboseb/agent): source code
`);
});

discovery.get("/openapi.json", (c) => {
  const base = (cfg.publicBaseUrl ?? `http://localhost:${cfg.port}`).replace(/\/$/, "");
  return c.json({
    openapi: "3.1.0",
    info: {
      title: SERVICE_NAME,
      version: "1.0.0",
      description: DESCRIPTION,
    },
    servers: [{ url: base }],
    paths: {
      "/v1/chat/completions": {
        post: {
          operationId: "createChatCompletion",
          summary: "OpenAI-compatible chat completion, paid per request via x402",
          description:
            "Standard OpenAI chat completions request. Without an X-PAYMENT header the " +
            "response is 402 with a base64 payment-required header quoting an `upto` " +
            "ceiling derived from max_tokens. Retry with a signed payment (any x402 v2 " +
            "client) to receive the completion; settlement bills actual usage at " +
            `upstream cost x ${cfg.markup}.`,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", ...INPUT_SCHEMA },
                example: INPUT_EXAMPLE,
              },
            },
          },
          responses: {
            "200": {
              description:
                "Chat completion (headers: X-Billed-Usd, X-Quoted-Ceiling-Usd, X-Cache, PAYMENT-RESPONSE)",
              content: { "application/json": { example: OUTPUT_EXAMPLE } },
            },
            "402": {
              description:
                "Payment required — decode the base64 `payment-required` response header for the x402 quote",
            },
            "400": { description: "Invalid request or unknown model" },
            "429": { description: "Gateway spend cap reached, retry shortly" },
            "502": { description: "Upstream provider error (payment canceled, nothing billed)" },
          },
        },
      },
      "/v1/embeddings": {
        post: {
          operationId: "createEmbedding",
          summary: "OpenAI-compatible embeddings, paid per request via x402",
          description:
            "Standard OpenAI embeddings request. Deterministic, so identical repeats are " +
            `cache hits billed at ${Math.round(cfg.hitMultiplierPrivate * 100)}% of provider price; misses at cost x ${cfg.markup}. ` +
            "Same x402 402/pay/retry flow as chat completions.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", ...EMBEDDINGS_INPUT_SCHEMA },
                example: EMBEDDINGS_INPUT_EXAMPLE,
              },
            },
          },
          responses: {
            "200": {
              description:
                "Embedding list (headers: X-Billed-Usd, X-Quoted-Ceiling-Usd, X-Cache, PAYMENT-RESPONSE)",
              content: { "application/json": { example: EMBEDDINGS_OUTPUT_EXAMPLE } },
            },
            "402": {
              description:
                "Payment required — decode the base64 `payment-required` response header for the x402 quote",
            },
            "400": { description: "Invalid request or unknown model" },
            "429": { description: "Gateway spend cap reached, retry shortly" },
            "502": { description: "Upstream provider error (payment canceled, nothing billed)" },
          },
        },
      },
    },
  });
});
