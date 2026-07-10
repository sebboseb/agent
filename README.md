# x402 inference gateway

OpenAI-compatible chat completions, paid per call in USDC over [x402](https://x402.org).
Uses the `upto` scheme: the buyer authorizes a ceiling computed from `max_tokens`,
and is settled for **actual token usage × markup** (default cost + 4%). Upstream
failures and bad requests cancel the payment — the buyer pays nothing.

## Layout

- `src/server.ts` — gateway: 402 quote → facilitator verify → OpenAI → settle actual
- `src/models.ts` — model/price registry (**keep prices in sync with OpenAI's pricing page**)
- `src/ledger.ts` — SQLite book of record (every request: quoted, cost, billed, settled, payer, tx)
- `src/buyer.ts` — test buyer: Permit2 approval + paid request, prints billing breakdown
- `test/e2e.ts` — full-loop test with mock facilitator + mock OpenAI, zero funds needed

## Verified without funds

```bash
npm run typecheck   # clean
npm run e2e         # full loop against mocks: ALL E2E CHECKS PASSED
```

## Testnet round trip (the real proof)

One-time setup:

1. `cp .env.example .env`, then fill in:
   - `PAY_TO_ADDRESS` — your receiving wallet **address** (server never needs its key)
   - `OPENAI_API_KEY` — real key (prepaid balance, hard limit set in OpenAI dashboard)
   - `BUYER_PRIVATE_KEY` — the **separate** test buyer wallet's private key
2. Fund the buyer wallet on **Base Sepolia**:
   - test USDC: https://faucet.circle.com (select Base Sepolia)
   - a little test ETH for the one-time Permit2 approval tx:
     https://portal.cdp.coinbase.com/products/faucet

Run it:

```bash
npm start           # terminal 1 — gateway on :8402
npm run buyer       # terminal 2 — approves Permit2 (first run), pays, prints settlement
```

Success looks like: `status: 200`, the model reply, `billed: $0.000x`,
and `settled on-chain: ... atomic USDC | tx 0x...` — then check the ledger:

```bash
sqlite3 ledger.db 'SELECT id, model, upstream_cost_usd, billed_usd, settled_atomic, payer, status FROM requests ORDER BY ts DESC LIMIT 5;'
```

## Phase C — mainnet, deploy, Bazaar (runbook)

Code is done: CDP facilitator auth (`@coinbase/x402`), Bazaar discovery extension
on the route, Dockerfile + railway.json all wired. The steps that need a human:

1. **CDP API key**: portal.cdp.coinbase.com → API keys → create **Secret API key**.
   Put `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` in `.env`.
2. **Gate check**: `npm run check-cdp` — confirms the CDP facilitator supports
   `upto` on Base mainnet. **Do not proceed past this if it fails**; it prints the fallback.
3. **Deploy to Railway**: `railway up` from this directory (or connect a GitHub repo).
   Add a **volume mounted at `/data`**. Set env vars:
   `X402_NETWORK=mainnet`, `PAY_TO_ADDRESS`, `OPENAI_API_KEY`,
   `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `LEDGER_DB=/data/ledger.db`,
   `PUBLIC_BASE_URL=https://<your-app>.up.railway.app`, `PORT=8402`.
   Verify `https://<app>/healthz` and that `GET /` shows the model list.
4. **Fund the buyer wallet on Base mainnet**: ~$5 USDC (Coinbase → withdraw to the
   buyer address, network **Base**) plus a sliver of real ETH for the one-time
   mainnet Permit2 approval.
5. **Self-pay** (this is what triggers Bazaar indexing):
   `X402_NETWORK=mainnet GATEWAY_URL=https://<app>.up.railway.app npm run buyer`
6. **Verify listing**: `npm run check-listing -- https://<app>.up.railway.app`
   (indexing can take a few minutes after the settle). Also check x402scan.com.

After that: watch `ledger.db` for a couple of weeks — the repeated-prompt data in it
decides whether/when to build the cache tier (build order step 2).

## Notes

- Streaming and `n > 1` are intentionally stripped (settlement needs the complete
  response; multiple choices would exceed the quoted ceiling).
- Requests without `max_tokens` get `DEFAULT_MAX_TOKENS` so the quote stays honest.
- `GLOBAL_SPEND_CAP_PER_MIN_USD` caps upstream spend across all buyers (429 above it).
- Input tokens are estimated at 1 token / 3 chars (pessimistic) for the ceiling;
  billing uses the exact `usage` object from the upstream response.
