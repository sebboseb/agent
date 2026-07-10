import "dotenv/config";
import { createPublicClient, createWalletClient, http, formatUnits, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import {
  UptoEvmScheme,
  toClientEvmSigner,
  createPermit2ApprovalTx,
  getPermit2AllowanceReadParams,
} from "@x402/evm";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";

/**
 * Test buyer for the gateway. Does the full agent-side flow:
 *   1. one-time Permit2 approval for USDC (the upto scheme spends via Permit2)
 *   2. POST a chat completion, auto-handling the 402 -> sign -> retry loop
 *   3. print what was billed vs what was authorized
 *
 * Env: BUYER_PRIVATE_KEY (required), GATEWAY_URL, BUYER_MODEL, X402_NETWORK.
 * The buyer wallet needs testnet USDC (Circle faucet) and a little Base Sepolia
 * ETH for the one-time approval transaction.
 */

const NETWORKS = {
  testnet: {
    caip2: "eip155:84532",
    chain: baseSepolia,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const,
  },
  mainnet: {
    caip2: "eip155:8453",
    chain: base,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const,
  },
} as const;

const net = NETWORKS[(process.env.X402_NETWORK ?? "testnet") as keyof typeof NETWORKS];
const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:8402";
const model = process.env.BUYER_MODEL ?? "gpt-4o-mini";

const rawKey = process.env.BUYER_PRIVATE_KEY;
if (!rawKey) throw new Error("Set BUYER_PRIVATE_KEY (the test buyer wallet, NOT the receiving wallet)");
const privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`;
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
  throw new Error(
    `BUYER_PRIVATE_KEY must be 32 bytes: "0x" + 64 hex chars. Got ${privateKey.length - 2} hex chars — the key looks truncated or is not a private key.`,
  );
}
const account = privateKeyToAccount(privateKey);

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

async function ensurePermit2Approval() {
  const publicClient = createPublicClient({ chain: net.chain, transport: http() });

  const [balance, allowance] = await Promise.all([
    publicClient.readContract({ address: net.usdc, abi: erc20, functionName: "balanceOf", args: [account.address] }),
    publicClient.readContract(
      getPermit2AllowanceReadParams({ tokenAddress: net.usdc, ownerAddress: account.address }),
    ) as Promise<bigint>,
  ]);
  console.log(`buyer ${account.address}`);
  console.log(`USDC balance: ${formatUnits(balance, 6)} | Permit2 allowance: ${formatUnits(allowance, 6)}`);
  if (balance === 0n) {
    throw new Error("Buyer wallet has no USDC. Testnet: https://faucet.circle.com (Base Sepolia).");
  }
  if (allowance >= 100_000_000n) return; // >= 100 USDC approved, plenty

  console.log("Sending one-time Permit2 approval (needs a little ETH for gas)...");
  const walletClient = createWalletClient({ account, chain: net.chain, transport: http() });
  const tx = createPermit2ApprovalTx(net.usdc);
  const hash = await walletClient.sendTransaction({ to: tx.to, data: tx.data });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Permit2 approved: ${hash}`);
  // The facilitator verifies against its own RPC node, which may lag ours by a
  // few blocks — pay too fast after approving and verification 412s.
  console.log("Waiting 8s for the approval to propagate to the facilitator's node...");
  await new Promise((r) => setTimeout(r, 8000));
}

async function main() {
  if (process.env.E2E_MOCK !== "1") {
    await ensurePermit2Approval();
  }

  const publicClient = createPublicClient({ chain: net.chain, transport: http() });
  const signer = process.env.E2E_MOCK === "1" ? account : toClientEvmSigner(account, publicClient);
  const client = new x402Client().register(net.caip2, new UptoEvmScheme(signer));
  const fetchWithPay = wrapFetchWithPayment(fetch, client);

  console.log(`POST ${gatewayUrl}/v1/chat/completions (model ${model})`);
  const res = await fetchWithPay(`${gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with exactly: x402 gateway online" }],
      max_tokens: 32,
      temperature: 0,
    }),
  });

  console.log(`status: ${res.status}`);
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: unknown;
  };
  if (!res.ok) {
    console.error("request failed:", JSON.stringify(json, null, 2));
    const required = res.headers.get("payment-required");
    if (required) {
      const decoded = JSON.parse(Buffer.from(required, "base64").toString("utf8"));
      console.error("facilitator says:", decoded.error ?? "(no error field)");
      if (decoded.accepts?.[0]) console.error("re-quoted:", JSON.stringify(decoded.accepts[0]));
    }
    process.exit(1);
  }
  console.log(`response: ${json.choices?.[0]?.message?.content}`);
  console.log(`quoted ceiling: $${res.headers.get("x-quoted-ceiling-usd")}`);
  console.log(`billed:         $${res.headers.get("x-billed-usd")} (cache ${res.headers.get("x-cache")})`);

  const paymentHeader = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
  if (paymentHeader) {
    const settle = decodePaymentResponseHeader(paymentHeader);
    console.log(
      `settled on-chain: ${settle.amount ?? "?"} atomic USDC | tx ${settle.transaction} | payer ${settle.payer}`,
    );
  } else {
    console.log("no PAYMENT-RESPONSE header found");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
