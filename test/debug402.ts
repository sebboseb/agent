import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { startMockFacilitator } from "./mock-facilitator.js";
import { startMockUpstream } from "./mock-upstream.js";

const receiver = privateKeyToAccount(generatePrivateKey());
process.env.X402_NETWORK = "testnet";
process.env.FACILITATOR_URL = "http://127.0.0.1:9412";
process.env.OPENAI_BASE_URL = "http://127.0.0.1:9413/v1";
process.env.OPENAI_API_KEY = "sk-mock";
process.env.PAY_TO_ADDRESS = receiver.address;
process.env.LEDGER_DB = "./debug-ledger.db";
process.env.PORT = "9411";

await startMockFacilitator(9412);
await startMockUpstream(9413);
const { startGateway } = await import("../src/server.js");
await startGateway();

const res = await fetch("http://127.0.0.1:9411/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], max_tokens: 32 }),
});
console.log("status", res.status);
console.log("headers", JSON.stringify(Object.fromEntries(res.headers.entries()), null, 2));
console.log("body", await res.text());
process.exit(0);
