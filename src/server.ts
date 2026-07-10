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
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { createFacilitatorConfig } from "@coinbase/x402";
import { cfg } from "./config.js";
import { MODELS, estimateCeilingUsd, actualCostUsd, type ChatBody } from "./models.js";
import { ledger } from "./ledger.js";
import { callUpstream, UpstreamError } from "./upstream.js";

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

function openaiError(message: string, type: string) {
  return { error: { message, type, param: null, code: null } };
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
      description:
        "OpenAI-compatible chat completions, pay per call in USDC. " +
        "upto scheme: you authorize a ceiling based on max_tokens, and are billed " +
        `actual token usage at cost + ${Math.round((cfg.markup - 1) * 100)}%. ` +
        `Models: ${Object.keys(MODELS).join(", ")}. ` +
        "Standard OpenAI request format (streaming not supported).",
      mimeType: "application/json",
      serviceName: "x402 inference gateway",
      tags: ["inference", "llm", "openai", "chat-completions", "ai"],
      ...(cfg.publicBaseUrl
        ? { resource: `${cfg.publicBaseUrl.replace(/\/$/, "")}/v1/chat/completions` }
        : {}),
      // Bazaar discovery: how agents find and learn to call this endpoint.
      extensions: declareDiscoveryExtension({
        bodyType: "json",
        input: {
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "Summarize this in one sentence: ..." }],
          max_tokens: 256,
          temperature: 0,
        },
        inputSchema: {
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
        },
        output: {
          example: {
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
          },
        },
      }),
    },
  };

  const app = new Hono();

  // Unpaid info endpoints: model list with pricing lets agents estimate before paying.
  app.get("/", (c) =>
    c.json({
      service: "x402 inference gateway",
      endpoint: "POST /v1/chat/completions",
      network: cfg.network,
      pricing: `upstream cost x ${cfg.markup}, billed on actual usage (upto scheme)`,
      models: Object.fromEntries(
        Object.entries(MODELS).map(([name, m]) => [
          name,
          { usd_per_mtok_input: m.inputPerMtok, usd_per_mtok_output: m.outputPerMtok },
        ]),
      ),
    }),
  );
  app.get("/healthz", (c) => c.json({ ok: true }));

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
    if (ledger.upstreamSpendUsdSince(Date.now() - 60_000) >= cfg.globalSpendCapPerMinUsd) {
      return c.json(openaiError("gateway is at capacity, retry shortly", "rate_limit_error"), 429);
    }

    const ceilingUsd = estimateCeilingUsd(body);
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
