// Boots the gateway against the REAL x402.org testnet facilitator and checks
// the unpaid 402 quote. No secrets, no funds — validates facilitator sync only.
import { decodePaymentRequiredHeader } from "@x402/core/http";

process.env.X402_NETWORK = "testnet";
process.env.PAY_TO_ADDRESS = "0x000000000000000000000000000000000000dEaD";
process.env.OPENAI_API_KEY = "sk-dummy-not-used-by-402-path";
process.env.LEDGER_DB = "./live-check-ledger.db";
process.env.PORT = "9421";

const { startGateway } = await import("../src/server.js");
await startGateway();

const res = await fetch("http://127.0.0.1:9421/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "Reply with exactly: x402 gateway online" }],
    max_tokens: 32,
  }),
});
console.log("status:", res.status);
const header = res.headers.get("payment-required");
if (res.status !== 402 || !header) {
  console.error("FAIL: expected 402 with payment-required header");
  process.exit(1);
}
const quote = decodePaymentRequiredHeader(header);
console.log("quote:", JSON.stringify(quote.accepts[0], null, 2));
const extra = quote.accepts[0].extra as Record<string, unknown>;
if (quote.accepts[0].scheme === "upto" && typeof extra?.facilitatorAddress === "string") {
  console.log("LIVE 402 CHECK PASSED — real facilitator advertises upto and enriched the quote");
  process.exit(0);
}
console.error("FAIL: quote missing upto/facilitatorAddress");
process.exit(1);
