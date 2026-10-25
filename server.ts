#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import {
  BASE_MAINNET,
  CachedFetcher,
  REFUSAL_PREFIX,
  SpendLimiter,
  fail,
  isValidPrivateKey,
  mapError,
  mapResponse,
  normalizeSlug,
  parseConfig,
  validateRequirements,
  withTimeout,
  type Config,
} from "./lib.js";

let config: Config;
try {
  config = parseConfig(process.env);
} catch (e) {
  console.error(`Configuration error: ${(e as Error).message}`);
  process.exit(1);
}

// Never print or echo the key itself, only whether it has the right shape.
const pk = process.env.EVM_PRIVATE_KEY?.trim();
if (!isValidPrivateKey(pk)) {
  console.error(
    "EVM_PRIVATE_KEY is missing or malformed (expected 0x followed by 64 hex characters; wallet with USDC on Base).",
  );
  process.exit(1);
}

let account: ReturnType<typeof privateKeyToAccount>;
try {
  account = privateKeyToAccount(pk);
} catch {
  console.error("EVM_PRIVATE_KEY could not be used to create a wallet.");
  process.exit(1);
}

const limiter = new SpendLimiter(config.maxRequests);

// Only Base mainnet is registered (no "eip155:*" wildcard), so challenges for other
// EVM networks cannot be signed. The hook below re-checks every challenge before signing.
const client = new x402Client();
client.register(BASE_MAINNET, new ExactEvmScheme(account));

client
  .onBeforePaymentCreation(async (ctx) => {
    const reason = validateRequirements(ctx.selectedRequirements);
    if (reason) return { abort: true, reason: `${REFUSAL_PREFIX}${reason}` };
    if (!limiter.tryReserve()) {
      return {
        abort: true,
        reason: `${REFUSAL_PREFIX}paid request limit (${config.maxRequests}) for this session reached`,
      };
    }
  })
  .onPaymentCreationFailure(async () => {
    limiter.release();
  });

const payFetch = wrapFetchWithPayment(fetch, client);

async function load(slug: string) {
  try {
    // No automatic retries: one tool call is at most one payment attempt.
    const res = await withTimeout(
      async (signal) => {
        const r = await payFetch(config.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ collection: slug }),
          redirect: "error",
          signal,
        });
        return { status: r.status, body: await r.text(), retryAfter: r.headers.get("Retry-After") };
      },
      config.timeoutMs,
    );
    return mapResponse(res.status, res.body, res.retryAfter);
  } catch (e) {
    return mapError(e);
  }
}

const fetcher = new CachedFetcher(load);

const server = new McpServer({ name: "nftdata", version: "1.0.0" });

server.tool(
  "get_collection_data",
  "Get OpenSea NFT collection market data in one call: name, contracts, floor price, " +
    "1/7/30-day and lifetime sales and volume, unique owners, total supply, creation date. " +
    "Costs $0.002 per call (x402). " +
    "`collection` is the OpenSea slug from the collection URL: opensea.io/collection/<slug> " +
    "(e.g. 'azuki', 'basedpunks'); it is trimmed and lowercased. " +
    "Prices are in the currency given in the *_currency fields (ETH, USDC, HYPE...).",
  {
    collection: z.string().max(200).describe("OpenSea collection slug, e.g. 'azuki'"),
  },
  async ({ collection }) => {
    const slug = normalizeSlug(collection);
    if (slug === null) {
      return fail("Invalid slug: use only letters, digits, '_' and '-' (max 100 characters).");
    }
    return fetcher.get(slug);
  },
);

await server.connect(new StdioServerTransport());
