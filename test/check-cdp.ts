import "dotenv/config";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";

/**
 * Authenticated probe of the CDP mainnet facilitator. Answers the one question
 * phase C hinges on: does it support the `upto` scheme on Base (eip155:8453)?
 * Needs CDP_API_KEY_ID / CDP_API_KEY_SECRET in .env.
 */
const client = new HTTPFacilitatorClient(createFacilitatorConfig());
const supported = await client.getSupported();

const kinds = supported.kinds.filter((k) => k.network === "eip155:8453");
console.log("CDP facilitator kinds on Base mainnet:");
for (const k of kinds) console.log(`  v${k.x402Version} ${k.scheme}`, k.extra ?? "");

const upto = kinds.find((k) => k.scheme === "upto" && k.x402Version === 2);
if (upto) {
  console.log("\nOK: upto is supported on Base mainnet — settle-actual works as built.");
} else {
  console.log(
    "\nWARNING: no upto on Base mainnet at this facilitator. Fallback: switch the route to" +
      " scheme 'exact' with the same dynamic ceiling price (buyers pay the quoted ceiling," +
      " not actual usage) until upto lands. Ask before changing anything.",
  );
  process.exit(1);
}
