import "dotenv/config";

export type NetworkName = "testnet" | "mainnet";

const networkName = (process.env.X402_NETWORK ?? "testnet") as NetworkName;
if (networkName !== "testnet" && networkName !== "mainnet") {
  throw new Error(`X402_NETWORK must be "testnet" or "mainnet", got "${networkName}"`);
}

const NETWORKS = {
  testnet: {
    caip2: "eip155:84532", // Base Sepolia
    facilitator: "https://x402.org/facilitator",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
  mainnet: {
    caip2: "eip155:8453", // Base
    facilitator: "https://api.cdp.coinbase.com/platform/v2/x402",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
} as const;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

// The CDP facilitator (mainnet) authenticates every call; the x402.org
// facilitator (testnet) is open. Mainnet without CDP keys fails at startup
// rather than at the first customer.
const cdpApiKeyId = process.env.CDP_API_KEY_ID;
const cdpApiKeySecret = process.env.CDP_API_KEY_SECRET;
if (networkName === "mainnet" && !process.env.FACILITATOR_URL && (!cdpApiKeyId || !cdpApiKeySecret)) {
  throw new Error("Mainnet needs CDP_API_KEY_ID and CDP_API_KEY_SECRET (portal.cdp.coinbase.com -> API keys -> Secret API key)");
}

export const cfg = {
  networkName,
  network: NETWORKS[networkName].caip2,
  usdcAddress: NETWORKS[networkName].usdc,
  facilitatorUrl: process.env.FACILITATOR_URL ?? NETWORKS[networkName].facilitator,
  cdpApiKeyId,
  cdpApiKeySecret,
  /** Public base URL of this deployment; used for the Bazaar resource URL. */
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  port: Number(process.env.PORT ?? 8402),
  payTo: requireEnv("PAY_TO_ADDRESS"),
  openaiApiKey: requireEnv("OPENAI_API_KEY"),
  openaiBaseUrl: (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, ""),
  ledgerDb: process.env.LEDGER_DB ?? "./ledger.db",
  /** Multiplier applied to upstream cost to get the buyer's price. */
  markup: Number(process.env.MARKUP ?? 1.04),
  /** Hard ceiling on upstream spend per rolling minute, across all buyers. */
  globalSpendCapPerMinUsd: Number(process.env.GLOBAL_SPEND_CAP_PER_MIN_USD ?? 5),
  /** max_tokens applied when the request omits it, so the quote stays honest. */
  defaultMaxTokens: Number(process.env.DEFAULT_MAX_TOKENS ?? 1024),
  hardMaxTokens: Number(process.env.HARD_MAX_TOKENS ?? 8192),
  /**
   * Smallest amount we settle, in USD. The CDP mainnet facilitator rejects
   * settlements below its minimum (`amount_too_low` at $0.0001), so this is
   * also the effective minimum charge per request.
   */
  minBillUsd: Number(process.env.MIN_BILL_USD ?? 0.001),
};
