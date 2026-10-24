# nftdata-mcp

An MCP server that exposes the [NFT Data](https://www.nftdata.app/) API to AI clients (Claude Desktop, Cursor, etc.) as a single tool. It handles the x402 payment flow automatically.

## Tool

### `get_collection_data`

Returns OpenSea collection market data in one call.

| Parameter    | Type   | Description                                                                 |
|--------------|--------|-----------------------------------------------------------------------------|
| `collection` | string | OpenSea collection slug, from `opensea.io/collection/<slug>` (e.g. `azuki`) |

Returned fields: `name`, `slug`, `contracts`, `floor_price`, `floor_price_currency`, `one_day_sales`, `one_day_volume`, `seven_day_sales`, `seven_day_volume`, `thirty_day_sales`, `thirty_day_volume`, `total_sales`, `total_volume`, `num_owners`, `total_supply`, `created_date`. Volume and price currencies are given in the matching `*_currency` fields (ETH, USDC, HYPE, ...).

Each call costs **$0.002** (USDC on Base, paid via x402).

## Requirements

- Node.js 20+
- A wallet private key funded with a small amount of USDC on Base

> Use a dedicated wallet with only a small balance. Never use your main wallet.

## Quick start (npx)

No cloning required. Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "nftdata": {
      "command": "npx",
      "args": ["-y", "nftdata-mcp"],
      "env": {
        "EVM_PRIVATE_KEY": "0x..."
      }
    }
  }
}
```

If the package is published under a scope, use that name instead (e.g. `@your-scope/nftdata-mcp`).

## Run from source

```bash
npm install
EVM_PRIVATE_KEY=0x... npm start
```

To use a local checkout with Claude Desktop, point `args` to `["tsx", "/absolute/path/to/nftdata-mcp/server.ts"]` with `"command": "npx"`.

## Build

```bash
npm run build   # compiles server.ts to dist/server.js
```

Restart Claude Desktop, then ask for example: "What is the floor price and 7-day volume of azuki?"

## Configuration

| Variable                | Required | Default                                            | Description                                   |
|-------------------------|----------|----------------------------------------------------|-----------------------------------------------|
| `EVM_PRIVATE_KEY`       | yes      | –                                                  | Private key of the wallet that pays for calls |
| `NFTDATA_MAX_REQUESTS`  | no       | `100`                                              | Max paid requests per session                 |
| `NFTDATA_URL`           | no       | `https://www.nftdata.app/api/get-collection-data`  | Override the API endpoint                     |

## Behavior

- Sends `POST /api/get-collection-data` with body `{"collection": "<slug>"}`.
- On `402 Payment Required`, signs an x402 payment (Base, USDC) and retries.
- Caches responses for 5 minutes per slug to avoid paying twice.
- Stops after `NFTDATA_MAX_REQUESTS` paid calls per session.
- Returns clear errors for `400` (invalid slug), `404` (collection not found) and `429` (rate limit, with `Retry-After`).

## Limitations

- Only x402 on Base is supported. Solana and MPP payment methods are not implemented in this wrapper.
- The x402 client libraries change quickly; if imports fail, check the current [x402 docs](https://docs.x402.org/).

## API reference

- OpenAPI: https://www.nftdata.app/openapi.json
- Docs: https://www.nftdata.app/docs
