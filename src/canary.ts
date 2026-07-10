import { createPublicClient, createWalletClient, http, formatUnits, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import {
  UptoEvmScheme,
  toClientEvmSigner,
  createPermit2ApprovalTx,
  getPermit2AllowanceReadParams,
} from "@x402/evm";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { cfg } from "./config.js";

/**
 * Heartbeat self-purchase. The Bazaar delists resources with no settled
 * payment in 30 days and ranks on recency, so the gateway buys one minimal
 * completion from itself per interval (~$0.001/day) through the public URL —
 * which doubles as end-to-end synthetic monitoring of DNS, TLS, facilitator,
 * upstream, and settlement.
 *
 * Enabled only when CANARY_PRIVATE_KEY is set (a dedicated wallet holding a
 * few USDC + a sliver of ETH on Base; never the revenue wallet).
 */

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const INTERVAL_MS = Number(process.env.CANARY_INTERVAL_HOURS ?? 24) * 3600_000;
const JITTER_MS = 3600_000; // spread runs so the heartbeat isn't a metronome

async function runOnce(): Promise<void> {
  const key = process.env.CANARY_PRIVATE_KEY as `0x${string}`;
  const account = privateKeyToAccount(key.startsWith("0x") ? key : (`0x${key}` as `0x${string}`));
  const publicClient = createPublicClient({ chain: base, transport: http() });

  const [usdc, allowance] = await Promise.all([
    publicClient.readContract({
      address: cfg.usdcAddress as `0x${string}`,
      abi: erc20,
      functionName: "balanceOf",
      args: [account.address],
    }),
    publicClient.readContract(
      getPermit2AllowanceReadParams({
        tokenAddress: cfg.usdcAddress as `0x${string}`,
        ownerAddress: account.address,
      }),
    ) as Promise<bigint>,
  ]);
  if (usdc < 10_000n) {
    console.warn(
      `[canary] wallet ${account.address} has ${formatUnits(usdc, 6)} USDC — refill needed, skipping run`,
    );
    return;
  }
  if (allowance < 1_000_000n) {
    console.log("[canary] sending one-time Permit2 approval...");
    const walletClient = createWalletClient({ account, chain: base, transport: http() });
    const tx = createPermit2ApprovalTx(cfg.usdcAddress as `0x${string}`);
    const hash = await walletClient.sendTransaction({ to: tx.to, data: tx.data });
    await publicClient.waitForTransactionReceipt({ hash });
    await new Promise((r) => setTimeout(r, 10_000)); // facilitator RPC propagation
    console.log(`[canary] Permit2 approved: ${hash}`);
  }

  const signer = toClientEvmSigner(account, publicClient);
  const client = new x402Client().register(cfg.network as never, new UptoEvmScheme(signer));
  const fetchWithPay = wrapFetchWithPayment(fetch, client);

  const res = await fetchWithPay(`${cfg.publicBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.CANARY_MODEL ?? "gpt-5.4-nano",
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      max_tokens: 8,
      temperature: 0,
    }),
  });
  if (res.ok) {
    console.log(
      `[canary] OK — billed $${res.headers.get("x-billed-usd")}, USDC left ${formatUnits(usdc, 6)}`,
    );
  } else {
    console.error(`[canary] FAILED status ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

export function startCanary(): void {
  if (!process.env.CANARY_PRIVATE_KEY) return;
  if (!cfg.publicBaseUrl) {
    console.warn("[canary] CANARY_PRIVATE_KEY set but PUBLIC_BASE_URL missing — canary disabled");
    return;
  }
  const tick = () => {
    runOnce().catch((err) => console.error("[canary] error:", String(err).slice(0, 300)));
    setTimeout(tick, INTERVAL_MS + Math.floor(Math.random() * JITTER_MS));
  };
  // First run shortly after boot so a fresh deploy immediately proves the loop.
  setTimeout(tick, 60_000);
  console.log(`[canary] armed: every ~${INTERVAL_MS / 3600_000}h against ${cfg.publicBaseUrl}`);
}
