import "dotenv/config";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { withBazaar } from "@x402/extensions/bazaar";
import { createFacilitatorConfig } from "@coinbase/x402";

/**
 * Confirm the gateway is in the Bazaar catalog. The catalog's server-side
 * filters are ignored and its ordering is not recency-based (verified
 * 2026-07-10), so the only reliable check is a full paginated scan (~260
 * requests). Matches on host or PAY_TO_ADDRESS.
 */
const base = process.argv[2] ?? process.env.PUBLIC_BASE_URL;
if (!base) throw new Error("Usage: npm run check-listing -- https://your-app.up.railway.app");

const client = withBazaar(new HTTPFacilitatorClient(createFacilitatorConfig()));
const needles = [new URL(base).host.toLowerCase()];
if (process.env.PAY_TO_ADDRESS) needles.push(process.env.PAY_TO_ADDRESS.toLowerCase());

let offset = 0;
let total = Infinity;
const mine: unknown[] = [];
while (offset < total) {
  const page = await client.extensions.bazaar.listResources({ limit: 100, offset } as never);
  total = page.pagination?.total ?? 0;
  mine.push(...page.items.filter((r) => {
    const j = JSON.stringify(r).toLowerCase();
    return needles.some((n) => j.includes(n));
  }));
  if (page.items.length === 0) break;
  offset += page.items.length;
  await new Promise((r) => setTimeout(r, 100));
}

console.log(`Bazaar catalog: scanned ${offset}/${total} resources`);
if (mine.length > 0) {
  console.log(`LISTED — found ${mine.length} entr${mine.length === 1 ? "y" : "ies"}:`);
  for (const r of mine) console.log(JSON.stringify(r).slice(0, 400));
} else {
  console.log(`NOT LISTED YET for ${base}. Indexing follows the first settled payment; wait and re-run.`);
  process.exit(1);
}
