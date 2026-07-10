import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { paymentMiddleware, setSettlementOverrides } from "@x402/hono";
import {
  x402ResourceServer,
  HTTPFacilitatorClient,
  type RoutesConfig,
  type HTTPTransportContext,
  type HTTPRequestContext,
} from "@x402/core/server";
import { UptoEvmScheme } from "@x402/evm/upto/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import type { Context } from "hono";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import {
  SERVICE_NAME,
  DESCRIPTION,
  TAGS,
  EMBEDDINGS_DESCRIPTION,
  EMBEDDINGS_TAGS,
  discoveryExtension,
  embeddingsDiscoveryExtension,
  publicResourceUrl,
  publicEmbeddingsUrl,
} from "./catalog.js";
import { discovery } from "./discovery.js";
import { cfg } from "./config.js";
import {
  MODELS,
  EMBEDDING_MODELS,
  estimateCeilingUsd,
  estimateEmbeddingsCeilingUsd,
  actualCostUsd,
  actualEmbeddingsCostUsd,
  effectiveMaxTokens,
  type ChatBody,
  type EmbeddingsBody,
} from "./models.js";
import { ledger } from "./ledger.js";
import { callUpstream, callEmbeddingsUpstream, UpstreamError } from "./upstream.js";
import { responseCache, cacheKey, type CacheScope } from "./cache.js";
import { dashboard } from "./dashboard.js";

/**
 * x402 inference gateway.
 *
 * Flow per paid request (all orchestrated by @x402/hono middleware):
 *   1. No payment header  -> 402 with an `upto` ceiling quoted from the request body
 *   2. Payment header     -> facilitator verifies BEFORE the handler runs
 *                            (no verified payment, no upstream spend)
 *   3. Handler            -> forwards to OpenAI, computes actual cost,
 *                            sets settlement override = actual cost x markup
 *   4. Handler 4xx/5xx    -> payment canceled, buyer pays nothing
 *   5. Settlement         -> facilitator settles the override amount (<= ceiling)
 */

/** Ceiling quoted in the 402 — recomputed identically at billing time. */
const dynamicCeiling = async (context: HTTPRequestContext) => {
  const body = ((await context.adapter.getBody?.()) ?? {}) as ChatBody;
  return `$${estimateCeilingUsd(body).toFixed(6)}`;
};

const dynamicEmbeddingsCeiling = async (context: HTTPRequestContext) => {
  const body = ((await context.adapter.getBody?.()) ?? {}) as EmbeddingsBody;
  return `$${estimateEmbeddingsCeilingUsd(body).toFixed(6)}`;
};

function openaiError(message: string, type: string) {
  return { error: { message, type, param: null, code: null } };
}

/**
 * Payer address from the (already facilitator-verified) payment header —
 * the namespace for private cache isolation. Undefined disables caching for
 * the request rather than risking a cross-tenant leak.
 */
function extractPayer(c: Context): string | undefined {
  const header = c.req.header("payment-signature") ?? c.req.header("x-payment");
  if (!header) return undefined;
  try {
    const payload = decodePaymentSignatureHeader(header).payload as Record<string, unknown>;
    const permit2 = payload?.permit2Authorization as Record<string, unknown> | undefined;
    if (typeof permit2?.from === "string") return permit2.from;
    const authorization = payload?.authorization as Record<string, unknown> | undefined;
    if (typeof authorization?.from === "string") return authorization.from;
    return undefined;
  } catch {
    return undefined;
  }
}

interface CachePlan {
  read: boolean;
  write: boolean;
  key?: string;
  scope: CacheScope;
  ttlMs: number;
}

/**
 * Buyer-facing cache controls:
 *   X-Cache: bypass       — skip the read (fresh result, still stored)
 *   X-Cache: force        — cache even non-deterministic requests
 *   X-Cache-Scope: shared — opt in to the cross-tenant pool (cheaper hits)
 *   X-Cache-TTL: <secs>   — override the default TTL (capped)
 */
function planCache(
  c: Context,
  endpoint: string,
  keyParams: Record<string, unknown>,
  deterministic: boolean,
): CachePlan {
  const control = (c.req.header("x-cache") ?? "").toLowerCase();
  const scope: CacheScope =
    (c.req.header("x-cache-scope") ?? "").toLowerCase() === "shared" ? "shared" : "private";
  const ttlHeader = Number(c.req.header("x-cache-ttl"));
  const ttlMs =
    Number.isFinite(ttlHeader) && ttlHeader > 0
      ? Math.min(ttlHeader * 1000, cfg.cacheMaxTtlMs)
      : cfg.cacheTtlMs;

  const cacheable = deterministic || control === "force";
  if (!cacheable) return { read: false, write: false, scope, ttlMs };

  const payer = extractPayer(c);
  if (scope === "private" && !payer) return { read: false, write: false, scope, ttlMs };

  return {
    read: control !== "bypass",
    write: true,
    key: cacheKey(endpoint, keyParams, scope, payer),
    scope,
    ttlMs,
  };
}

function hitMultiplier(scope: CacheScope): number {
  return scope === "shared" ? cfg.hitMultiplierShared : cfg.hitMultiplierPrivate;
}

/** Settlement hooks fire outside the handler; the request id response header links them back to the ledger row. */
function requestIdFrom(transportContext: unknown): string | undefined {
  const tc = transportContext as HTTPTransportContext | undefined;
  return tc?.responseHeaders?.["x-request-id"] ?? tc?.responseHeaders?.["X-Request-Id"];
}

export function facilitatorConfig() {
  // Mainnet: CDP facilitator with signed auth headers (also what indexes us in
  // the Bazaar on first settlement). Testnet / explicit override: plain URL.
  if (cfg.networkName === "mainnet" && !process.env.FACILITATOR_URL) {
    return createFacilitatorConfig(cfg.cdpApiKeyId, cfg.cdpApiKeySecret);
  }
  return { url: cfg.facilitatorUrl };
}

export function createGateway() {
  const facilitator = new HTTPFacilitatorClient(facilitatorConfig());
  const resourceServer = new x402ResourceServer(facilitator)
    .register(cfg.network as never, new UptoEvmScheme())
    .onAfterSettle(async ({ result, transportContext }) => {
      const id = requestIdFrom(transportContext);
      if (id) ledger.markSettled(id, result.amount ?? "", result.payer ?? "", result.transaction);
    })
    .onSettleFailure(async ({ error, transportContext }) => {
      const id = requestIdFrom(transportContext);
      if (id) ledger.markSettleFailed(id, String(error));
    })
    .onVerifiedPaymentCanceled(async ({ reason, transportContext }) => {
      const id = requestIdFrom(transportContext);
      if (id) ledger.markCanceled(id, reason);
    });

  const routes: RoutesConfig = {
    "POST /v1/chat/completions": {
      accepts: {
        scheme: "upto",
        payTo: cfg.payTo,
        network: cfg.network as never,
        price: dynamicCeiling,
        maxTimeoutSeconds: 300,
      },
      description: DESCRIPTION,
      mimeType: "application/json",
      serviceName: SERVICE_NAME,
      tags: TAGS,
      ...(cfg.publicBaseUrl ? { resource: publicResourceUrl() } : {}),
      // Bazaar discovery: how agents find and learn to call this endpoint.
      extensions: discoveryExtension(),
    },
    "POST /v1/embeddings": {
      accepts: {
        scheme: "upto",
        payTo: cfg.payTo,
        network: cfg.network as never,
        price: dynamicEmbeddingsCeiling,
        maxTimeoutSeconds: 300,
      },
      description: EMBEDDINGS_DESCRIPTION,
      mimeType: "application/json",
      serviceName: SERVICE_NAME,
      tags: EMBEDDINGS_TAGS,
      ...(cfg.publicBaseUrl ? { resource: publicEmbeddingsUrl() } : {}),
      extensions: embeddingsDiscoveryExtension(),
    },
  };

  const app = new Hono();

  // Unpaid info endpoints: model list with pricing lets agents estimate before paying.
  app.get("/", (c) => {
    const baseUrl = cfg.publicBaseUrl ?? `http://localhost:${cfg.port}`;
    return c.json({
      service: "x402 inference gateway",
      what: "OpenAI-compatible chat completions + embeddings, paid per request in USDC via x402. No account, no API key.",
      endpoints: [`POST ${baseUrl}/v1/chat/completions`, `POST ${baseUrl}/v1/embeddings`],
      cache: {
        rule: `deterministic requests (temperature 0; embeddings always) are cached — repeats bill at ${Math.round(cfg.hitMultiplierPrivate * 100)}% of provider price (private per payer) or ${Math.round(cfg.hitMultiplierShared * 100)}% with opt-in X-Cache-Scope: shared`,
        controls: "X-Cache: bypass|force, X-Cache-Scope: shared, X-Cache-TTL: <seconds>",
        receipt: "X-Cache: HIT|MISS response header on every call",
      },
      embedding_models_usd_per_mtok: Object.fromEntries(
        Object.entries(EMBEDDING_MODELS).map(([name, m]) => [name, { input: m.inputPerMtok }]),
      ),
      network: cfg.network,
      pricing: {
        rule: `upstream cost x ${cfg.markup}, billed on ACTUAL token usage (x402 'upto' scheme quotes a ceiling from max_tokens)`,
        minimum_usd_per_call: cfg.minBillUsd,
        models_usd_per_mtok: Object.fromEntries(
          Object.entries(MODELS).map(([name, m]) => [
            name,
            { input: m.inputPerMtok, output: m.outputPerMtok },
          ]),
        ),
      },
      quickstart: {
        typescript:
          "const fetchWithPay = wrapFetchWithPayment(fetch, new x402Client().register('" +
          cfg.network +
          "', new UptoEvmScheme(account))); await fetchWithPay('" +
          baseUrl +
          "/v1/chat/completions', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ model: 'gpt-5.4-nano', messages: [{ role: 'user', content: 'hello' }], max_tokens: 64 }) })",
        packages: "@x402/fetch @x402/evm viem",
        note: "Any x402-capable client works. Request body is standard OpenAI chat completions format; streaming and n>1 are not supported. Response headers X-Billed-Usd and X-Quoted-Ceiling-Usd show exact billing.",
      },
      limits: {
        default_max_tokens: cfg.defaultMaxTokens,
        hard_max_tokens: cfg.hardMaxTokens,
      },
    });
  });
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.route("/", discovery);
  // Operator dashboard (unpaid): live revenue + request feed from the ledger.
  app.route("/dashboard", dashboard);

  app.use(paymentMiddleware(routes, resourceServer));

  app.post("/v1/chat/completions", async (c) => {
    // Reaching this point means the facilitator verified a payment authorization.
    const requestId = randomUUID();
    c.header("X-Request-Id", requestId);

    const body = (await c.req.json().catch(() => null)) as ChatBody | null;
    if (!body || typeof body !== "object") {
      return c.json(openaiError("request body must be JSON", "invalid_request_error"), 400);
    }
    const model = body.model ? MODELS[body.model] : undefined;
    if (!model) {
      return c.json(
        openaiError(
          `unknown model '${body.model}' — available: ${Object.keys(MODELS).join(", ")}`,
          "invalid_request_error",
        ),
        400,
      );
    }

    const ceilingUsd = estimateCeilingUsd(body);
    // Everything that can change the output is part of the key.
    const plan = planCache(
      c,
      "chat",
      {
        model: body.model,
        messages: body.messages,
        tools: body.tools,
        tool_choice: body.tool_choice,
        response_format: body.response_format,
        seed: body.seed,
        stop: body.stop,
        temperature: body.temperature,
        top_p: body.top_p,
        presence_penalty: body.presence_penalty,
        frequency_penalty: body.frequency_penalty,
        logit_bias: body.logit_bias,
        logprobs: body.logprobs,
        top_logprobs: body.top_logprobs,
        max: effectiveMaxTokens(body),
      },
      body.temperature === 0,
    );

    if (plan.read && plan.key) {
      const hit = responseCache.get(plan.key);
      if (hit) {
        const billedUsd = Math.min(
          Math.max(hit.upstreamCostUsd * hitMultiplier(plan.scope), cfg.minBillUsd),
          ceilingUsd,
        );
        ledger.insertPending(requestId, body.model!, ceilingUsd);
        ledger.markCacheHit(requestId, hit.promptTokens, hit.completionTokens, billedUsd);
        setSettlementOverrides(c, { amount: `$${billedUsd.toFixed(6)}` });
        c.header("X-Cache", "HIT");
        c.header("X-Cache-Age-Seconds", String(Math.floor(hit.ageMs / 1000)));
        c.header("X-Quoted-Ceiling-Usd", ceilingUsd.toFixed(6));
        c.header("X-Billed-Usd", billedUsd.toFixed(6));
        return c.json(hit.response);
      }
    }

    if (ledger.upstreamSpendUsdSince(Date.now() - 60_000) >= cfg.globalSpendCapPerMinUsd) {
      return c.json(openaiError("gateway is at capacity, retry shortly", "rate_limit_error"), 429);
    }
    ledger.insertPending(requestId, body.model!, ceilingUsd);

    let upstream;
    try {
      upstream = await callUpstream(body);
    } catch (err) {
      ledger.markUpstreamError(requestId, String(err));
      const status = err instanceof UpstreamError && err.status === 429 ? 429 : 502;
      // Non-2xx cancels the verified payment: buyer pays nothing for upstream failures.
      return c.json(openaiError("upstream provider error", "api_error"), status);
    }

    const upstreamCostUsd = actualCostUsd(model, upstream.usage);
    const billedUsd = Math.min(
      Math.max(upstreamCostUsd * cfg.markup, cfg.minBillUsd),
      ceilingUsd,
    );
    ledger.markUpstreamOk(
      requestId,
      upstream.usage.prompt_tokens,
      upstream.usage.completion_tokens,
      upstreamCostUsd,
      billedUsd,
    );
    if (plan.write && plan.key) {
      responseCache.put(
        plan.key,
        "chat",
        body.model!,
        plan.scope,
        upstream.json,
        upstream.usage.prompt_tokens,
        upstream.usage.completion_tokens,
        upstreamCostUsd,
        plan.ttlMs,
      );
    }

    setSettlementOverrides(c, { amount: `$${billedUsd.toFixed(6)}` });
    c.header("X-Cache", "MISS");
    c.header("X-Quoted-Ceiling-Usd", ceilingUsd.toFixed(6));
    c.header("X-Billed-Usd", billedUsd.toFixed(6));
    return c.json(upstream.json);
  });

  app.post("/v1/embeddings", async (c) => {
    const requestId = randomUUID();
    c.header("X-Request-Id", requestId);

    const body = (await c.req.json().catch(() => null)) as EmbeddingsBody | null;
    if (!body || typeof body !== "object") {
      return c.json(openaiError("request body must be JSON", "invalid_request_error"), 400);
    }
    const model = body.model ? EMBEDDING_MODELS[body.model] : undefined;
    if (!model || body.input === undefined) {
      return c.json(
        openaiError(
          `model must be one of ${Object.keys(EMBEDDING_MODELS).join(", ")} and input is required`,
          "invalid_request_error",
        ),
        400,
      );
    }

    const ceilingUsd = estimateEmbeddingsCeilingUsd(body);
    // Embeddings are deterministic — always cacheable.
    const plan = planCache(
      c,
      "embeddings",
      {
        model: body.model,
        input: body.input,
        dimensions: body.dimensions,
        encoding_format: body.encoding_format,
      },
      true,
    );

    if (plan.read && plan.key) {
      const hit = responseCache.get(plan.key);
      if (hit) {
        const billedUsd = Math.min(
          Math.max(hit.upstreamCostUsd * hitMultiplier(plan.scope), cfg.minBillUsd),
          ceilingUsd,
        );
        ledger.insertPending(requestId, body.model!, ceilingUsd);
        ledger.markCacheHit(requestId, hit.promptTokens, 0, billedUsd);
        setSettlementOverrides(c, { amount: `$${billedUsd.toFixed(6)}` });
        c.header("X-Cache", "HIT");
        c.header("X-Cache-Age-Seconds", String(Math.floor(hit.ageMs / 1000)));
        c.header("X-Quoted-Ceiling-Usd", ceilingUsd.toFixed(6));
        c.header("X-Billed-Usd", billedUsd.toFixed(6));
        return c.json(hit.response);
      }
    }

    if (ledger.upstreamSpendUsdSince(Date.now() - 60_000) >= cfg.globalSpendCapPerMinUsd) {
      return c.json(openaiError("gateway is at capacity, retry shortly", "rate_limit_error"), 429);
    }
    ledger.insertPending(requestId, body.model!, ceilingUsd);

    let upstream;
    try {
      upstream = await callEmbeddingsUpstream(body);
    } catch (err) {
      ledger.markUpstreamError(requestId, String(err));
      const status = err instanceof UpstreamError && err.status === 429 ? 429 : 502;
      return c.json(openaiError("upstream provider error", "api_error"), status);
    }

    const upstreamCostUsd = actualEmbeddingsCostUsd(model, upstream.usage);
    const billedUsd = Math.min(
      Math.max(upstreamCostUsd * cfg.markup, cfg.minBillUsd),
      ceilingUsd,
    );
    ledger.markUpstreamOk(requestId, upstream.usage.prompt_tokens, 0, upstreamCostUsd, billedUsd);
    if (plan.write && plan.key) {
      responseCache.put(
        plan.key,
        "embeddings",
        body.model!,
        plan.scope,
        upstream.json,
        upstream.usage.prompt_tokens,
        0,
        upstreamCostUsd,
        plan.ttlMs,
      );
    }

    setSettlementOverrides(c, { amount: `$${billedUsd.toFixed(6)}` });
    c.header("X-Cache", "MISS");
    c.header("X-Quoted-Ceiling-Usd", ceilingUsd.toFixed(6));
    c.header("X-Billed-Usd", billedUsd.toFixed(6));
    return c.json(upstream.json);
  });

  return app;
}

export function startGateway(): Promise<ServerType> {
  const app = createGateway();
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: cfg.port }, (info) => {
      console.log(
        `x402 gateway listening on :${info.port} | network ${cfg.network} | facilitator ${cfg.facilitatorUrl} | payTo ${cfg.payTo}`,
      );
      resolve(server);
    });
  });
}
