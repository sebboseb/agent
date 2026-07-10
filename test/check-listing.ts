import "dotenv/config";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { withBazaar } from "@x402/extensions/bazaar";
import { createFacilitatorConfig } from "@coinbase/x402";

/**
 * After the first settled mainnet payment, confirm the gateway shows up in the
 * Bazaar catalog. Pass the deployed URL via PUBLIC_BASE_URL or first arg.
 */
const base = process.argv[2] ?? process.env.PUBLIC_BASE_URL;
if (!base) throw new Error("Usage: npm run check-listing -- https://your-app.up.railway.app");

const client = withBazaar(new HTTPFacilitatorClient(createFacilitatorConfig()));
const payTo = process.env.PAY_TO_ADDRESS;
const catalog = await client.extensions.bazaar.listResources(payTo ? { payTo } : {});
const mine = catalog.items.filter((r) =>
  JSON.stringify(r).toLowerCase().includes(new URL(base).host.toLowerCase()),
);

console.log(
  `Bazaar catalog: ${catalog.items.length} resources${payTo ? ` paying to ${payTo}` : " (first page)"}`,
);
if (mine.length > 0) {
  console.log(`LISTED — found ${mine.length} entr${mine.length === 1 ? "y" : "ies"} for ${base}:`);
  for (const r of mine) console.log(JSON.stringify(r, null, 2).slice(0, 800));
} else {
  console.log(
    `NOT LISTED YET for ${base}. Indexing happens on the first settled payment via the CDP` +
      " facilitator; if you just self-paid, wait a few minutes and re-run.",
  );
  process.exit(1);
}
