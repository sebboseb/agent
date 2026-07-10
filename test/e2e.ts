import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { UptoEvmScheme } from "@x402/evm";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { startMockFacilitator } from "./mock-facilitator.js";
import { startMockUpstream } from "./mock-upstream.js";

/**
 * Full-loop e2e with zero real funds:
 *   throwaway buyer key -> gateway 402 -> Permit2 signature -> mock facilitator
 *   verify -> mock OpenAI -> settle-actual -> ledger row settled.
 * The only things NOT covered are the real facilitator and the chain itself —
 * exactly what the testnet run (npm run buyer) then validates.
 */

const FACILITATOR_PORT = 9402;
const UPSTREAM_PORT = 9403;
const GATEWAY_PORT = 9401;
const DB_PATH = "./e2e-ledger.db";

// Env must be set before the gateway modules load their config.
const receiver = privateKeyToAccount(generatePrivateKey());
process.env.X402_NETWORK = "testnet";
process.env.FACILITATOR_URL = `http://127.0.0.1:${FACILITATOR_PORT}`;
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${UPSTREAM_PORT}/v1`;
process.env.OPENAI_API_KEY = "sk-mock";
process.env.PAY_TO_ADDRESS = receiver.address;
process.env.LEDGER_DB = DB_PATH;
process.env.PORT = String(GATEWAY_PORT);

for (const suffix of ["", "-wal", "-shm"]) {
  try {
    unlinkSync(DB_PATH + suffix);
  } catch {}
}

async function main() {
  await startMockFacilitator(FACILITATOR_PORT);
  await startMockUpstream(UPSTREAM_PORT);
  const { startGateway } = await import("../src/server.js");
  const { ledger } = await import("../src/ledger.js");
  await startGateway();

  const gateway = `http://127.0.0.1:${GATEWAY_PORT}`;

  // 1. Unpaid request gets a 402 quoting an upto ceiling
  const unpaid = await fetch(`${gateway}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], max_tokens: 32 }),
  });
  assert.equal(unpaid.status, 402, "unpaid request should 402");
  const requiredHeader = unpaid.headers.get("payment-required");
  assert.ok(requiredHeader, "402 should carry payment-required header");
  const quote = decodePaymentRequiredHeader(requiredHeader!);
  assert.ok(quote.accepts?.length, "402 should carry payment requirements");
  assert.equal(quote.accepts[0].scheme, "upto");
  assert.ok(Number(quote.accepts[0].amount) > 0, "quoted ceiling should be positive");
  console.log("PASS 402 quote:", JSON.stringify(quote.accepts[0]));

  // 2. Paying buyer with a throwaway key
  const buyer = privateKeyToAccount(generatePrivateKey());
  const client = new x402Client().register("eip155:84532", new UptoEvmScheme(buyer));
  const fetchWithPay = wrapFetchWithPayment(fetch, client);

  const res = await fetchWithPay(`${gateway}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Reply with exactly: x402 gateway online" }],
      max_tokens: 32,
      temperature: 0,
    }),
  });
  assert.equal(res.status, 200, `paid request should 200, got ${res.status}: ${await res.clone().text()}`);
  const json = (await res.json()) as { choices: { message: { content: string } }[] };
  assert.equal(json.choices[0].message.content, "x402 gateway online");
  console.log("PASS paid completion:", json.choices[0].message.content);

  const billed = Number(res.headers.get("x-billed-usd"));
  const ceiling = Number(res.headers.get("x-quoted-ceiling-usd"));
  assert.ok(billed > 0, "billed amount should be positive");
  assert.ok(billed <= ceiling, "billed must not exceed quoted ceiling");
  assert.equal(res.headers.get("x-cache"), "MISS");
  console.log(`PASS billing: billed $${billed} <= ceiling $${ceiling}`);

  const paymentHeader = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
  assert.ok(paymentHeader, "response should carry PAYMENT-RESPONSE header");
  const settle = decodePaymentResponseHeader(paymentHeader!);
  assert.equal(settle.success, true);
  assert.equal(settle.payer?.toLowerCase(), buyer.address.toLowerCase(), "settled payer should be the buyer");
  console.log(`PASS settlement: payer ${settle.payer}, tx ${settle.transaction}`);

  // 3. Ledger row fully accounted
  const requestId = res.headers.get("x-request-id");
  assert.ok(requestId, "response should carry X-Request-Id");
  const row = ledger.get(requestId!) as Record<string, unknown>;
  assert.equal(row.status, "settled", `ledger row should be settled, got ${row.status}`);
  assert.equal((row.payer as string).toLowerCase(), buyer.address.toLowerCase());
  assert.ok((row.billed_usd as number) > 0);
  console.log("PASS ledger:", JSON.stringify(row));

  // 4. Unknown model: 400, payment canceled, nothing billed
  const bad = await fetchWithPay(`${gateway}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "not-a-model", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(bad.status, 400, "unknown model should 400 (payment canceled, not settled)");
  console.log("PASS unknown model -> 400, payment canceled");

  // 5. Self-hosted discovery surfaces
  const wellKnown = (await (await fetch(`${gateway}/.well-known/x402.json`)).json()) as {
    x402Version: number;
    resources: { accepts: { scheme: string }[]; extensions?: Record<string, unknown> }[];
  };
  assert.equal(wellKnown.x402Version, 2);
  assert.equal(wellKnown.resources[0].accepts[0].scheme, "upto");
  assert.ok(wellKnown.resources[0].extensions, "manifest should carry bazaar extension");
  const llms = await (await fetch(`${gateway}/llms.txt`)).text();
  assert.ok(llms.startsWith("# x402 inference gateway"), "llms.txt should lead with H1");
  assert.ok(llms.includes("gpt-5.4-nano"), "llms.txt should list models");
  const openapi = (await (await fetch(`${gateway}/openapi.json`)).json()) as {
    openapi: string;
    paths: Record<string, unknown>;
  };
  assert.ok(openapi.openapi.startsWith("3.1"));
  assert.ok(openapi.paths["/v1/chat/completions"], "openapi should document the endpoint");
  console.log("PASS discovery surfaces: /.well-known/x402.json, /llms.txt, /openapi.json");

  console.log("\nALL E2E CHECKS PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("E2E FAILED:", err);
  process.exit(1);
});
