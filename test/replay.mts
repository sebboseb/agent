import "dotenv/config";
import { readFileSync } from "node:fs";
import { createAuthHeader } from "@coinbase/x402";
const HOST = "api.cdp.coinbase.com"; const PATH = "/platform/v2/x402/verify";
async function send(label: string, body: unknown) {
  const auth = await createAuthHeader(process.env.CDP_API_KEY_ID!, process.env.CDP_API_KEY_SECRET!, "POST", HOST, PATH);
  const res = await fetch(`https://${HOST}${PATH}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify(body),
  });
  console.log(`${label}: ${res.status} ${(await res.text()).slice(0, 130)}`);
}
const original = JSON.parse(readFileSync("verify-body.json", "utf8"));
await send("verbatim replay             ", original);

const noExt = structuredClone(original); delete noExt.paymentPayload.extensions;
await send("minus payload.extensions    ", noExt);

const noRes = structuredClone(original); noRes.paymentPayload.resource = { url: noRes.paymentPayload.resource.url };
await send("resource slimmed to url     ", noRes);

const noReqExtra = structuredClone(original);
console.log("paymentRequirements keys:", JSON.stringify(Object.keys(original.paymentRequirements)));
console.log("requirements.extra keys:", JSON.stringify(Object.keys(original.paymentRequirements.extra ?? {})));
console.log("requirements.extensions?:", JSON.stringify(original.paymentRequirements.extensions)?.slice(0, 100));
