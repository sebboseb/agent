import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";

/**
 * Minimal x402 facilitator for local e2e: accepts every payment.
 * Exercises the gateway's full quote -> verify -> settle plumbing without a chain.
 */

function extractPayer(paymentPayload: Record<string, unknown> | undefined): string {
  const payload = (paymentPayload?.payload ?? {}) as Record<string, unknown>;
  // upto scheme: payload.permit2Authorization.from
  const permit2Auth = payload.permit2Authorization as Record<string, unknown> | undefined;
  if (typeof permit2Auth?.from === "string") return permit2Auth.from;
  // exact scheme (EIP-3009): payload.authorization.from
  const authorization = payload.authorization as Record<string, unknown> | undefined;
  if (typeof authorization?.from === "string") return authorization.from;
  return "0x" + "11".repeat(20);
}

export function createMockFacilitator() {
  const app = new Hono();

  app.get("/supported", (c) =>
    c.json({
      kinds: [
        {
          x402Version: 2,
          scheme: "upto",
          network: "eip155:84532",
          extra: { facilitatorAddress: "0x" + "22".repeat(20) },
        },
      ],
      extensions: [],
      signers: {},
    }),
  );

  app.post("/verify", async (c) => {
    const body = (await c.req.json()) as { paymentPayload?: Record<string, unknown> };
    return c.json({ isValid: true, payer: extractPayer(body.paymentPayload) });
  });

  app.post("/settle", async (c) => {
    const body = (await c.req.json()) as {
      paymentPayload?: Record<string, unknown>;
      paymentRequirements?: { amount?: string; network?: string };
    };
    return c.json({
      success: true,
      transaction: "0x" + "ab".repeat(32),
      network: body.paymentRequirements?.network ?? "eip155:84532",
      payer: extractPayer(body.paymentPayload),
      amount: body.paymentRequirements?.amount ?? "0",
    });
  });

  return app;
}

export function startMockFacilitator(port: number): Promise<ServerType> {
  return new Promise((resolve) => {
    const server = serve({ fetch: createMockFacilitator().fetch, port }, () => resolve(server));
  });
}
