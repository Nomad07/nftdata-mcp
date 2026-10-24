#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const ENDPOINT = process.env.NFTDATA_URL ?? "https://www.nftdata.app/api/get-collection-data";

// Max paid requests per session (at $0.002 each, 100 = $0.20)
const MAX_REQUESTS = Number(process.env.NFTDATA_MAX_REQUESTS ?? 100);

const pk = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
if (!pk) {
  console.error("EVM_PRIVATE_KEY environment variable is required (wallet with USDC on Base)");
  process.exit(1);
}

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(pk) });
const payFetch = wrapFetchWithPayment(fetch, client);

// 5-minute cache so the same slug is not paid for twice
const cache = new Map<string, { at: number; body: string }>();
const TTL_MS = 5 * 60 * 1000;
let used = 0;

const fail = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

const server = new McpServer({ name: "nftdata", version: "1.0.0" });

server.tool(
  "get_collection_data",
  "Get OpenSea NFT collection market data in one call: name, contracts, floor price, " +
    "1/7/30-day and lifetime sales and volume, unique owners, total supply, creation date. " +
    "Costs $0.002 per call (x402). " +
    "`collection` is the OpenSea slug from the collection URL: opensea.io/collection/<slug> " +
    "(e.g. 'azuki', 'basedpunks'). Prices are in the currency given in the *_currency fields (ETH, USDC, HYPE...).",
  {
    collection: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase letters, digits, _ and - only")
      .describe("OpenSea collection slug, e.g. 'azuki'"),
  },
  async ({ collection }) => {
    const key = collection.trim().toLowerCase();

    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) {
      return { content: [{ type: "text", text: hit.body }] };
    }

    if (used >= MAX_REQUESTS) {
      return fail(`Paid request limit (${MAX_REQUESTS}) for this session reached.`);
    }

    try {
      used++;
      const res = await payFetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collection: key }),
      });
      const body = await res.text();

      if (res.status === 404) return fail(`Collection '${key}' not found. Check the slug in the OpenSea collection URL.`);
      if (res.status === 400) return fail(`Invalid slug: ${body.slice(0, 300)}`);
      if (res.status === 429) {
        return fail(`Rate limit exceeded. Retry in ${res.headers.get("Retry-After") ?? "?"} seconds.`);
      }
      if (!res.ok) return fail(`HTTP ${res.status}: ${body.slice(0, 500)}`);

      cache.set(key, { at: Date.now(), body });
      return { content: [{ type: "text", text: body }] };
    } catch (e) {
      return fail(`Request failed: ${(e as Error).message}`);
    }
  }
);

await server.connect(new StdioServerTransport());
