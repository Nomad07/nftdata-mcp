# nftdata-mcp

An MCP server that exposes the [NFT Data](https://www.nftdata.app/) API to AI clients (Claude Desktop, Cursor, etc.) as a single tool. It handles the x402 payment flow automatically.

- **npm:** https://www.npmjs.com/package/nftdata-mcp
- **MCP Registry:** https://registry.modelcontextprotocol.io/?q=nftdata

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

Add to `claude_desktop_config.json`:

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

Restart Claude Desktop, then ask for example: "What is the floor price and 7-day volume of azuki?"

## Run from source

```bash
npm install
```

Set the key for the current shell session only, then start:

```bash
# macOS / Linux
export EVM_PRIVATE_KEY=0x...
npm start
```

```powershell
# Windows PowerShell
$env:EVM_PRIVATE_KEY = "0x..."
npm start
```

```bat
:: Windows cmd
set EVM_PRIVATE_KEY=0x...
npm start
```

The server waits for an MCP client on stdin, so running it by hand just shows no output; it is meant to be launched by an MCP client.

To use a local checkout with Claude Desktop, point `args` to `["tsx", "/absolute/path/to/nftdata-mcp/server.ts"]` with `"command": "npx"`.

## Build

```bash
npm run build   # compiles server.ts and lib.ts to dist/
npm test        # offline unit tests, no network and no payments
```

## Configuration

| Variable               | Required | Default | Description |
|------------------------|----------|---------|-------------|
| `EVM_PRIVATE_KEY`      | yes      | –       | Private key (`0x` + 64 hex chars) of the wallet that pays for calls |
| `NFTDATA_MAX_REQUESTS` | no       | `100`   | Max signed payments per session. Integer 1–1000; any other value stops startup with an error |
| `NFTDATA_TIMEOUT_MS`   | no       | `15000` | Request timeout in milliseconds (1000–60000) |
| `NFTDATA_URL`          | no       | `https://www.nftdata.app/api/get-collection-data` | Accepts only the official NFT Data endpoint (`www.nftdata.app` or `nftdata.app`); anything else stops startup |

## Behavior

- Sends `POST /api/get-collection-data` with body `{"collection": "<slug>"}`.
- The slug is trimmed and lowercased, then must match `^[a-z0-9][a-z0-9_-]*$` (max 100 characters); otherwise no request is made.
- Only Base mainnet (`eip155:8453`) is registered with the x402 client. Before signing, every payment challenge is checked: scheme `exact`, network Base mainnet, token USDC on Base, amount exactly 2000 atomic units ($0.002), and recipient (must be `0x344143199642e87320785823c20c2df107d17534`). Anything else is refused without signing.
- Each signed payment counts against `NFTDATA_MAX_REQUESTS`, including payments for requests that later fail or time out.
- No automatic retries: one tool call makes at most one payment attempt.
- Caches successful responses for 5 minutes per slug. Concurrent identical calls share a single in-flight request.
- Returns generic errors for `400` (invalid slug), `404` (collection not found), `429` (rate limit, with `Retry-After`), timeouts and other failures; server and payment details are not passed to the MCP client.

## Limitations

- Only x402 on Base is supported. Solana and MPP payment methods are not implemented in this wrapper.
- The expected recipient address is hardcoded in `lib.ts`. If the NFT Data payout address ever changes, update `OFFICIAL_PAY_TO` and release a new version.
- The payment hook (`server.ts`) depends on the installed `@x402/*` SDK and is not covered by the offline tests.
- The x402 client libraries change quickly; if imports fail, check the current [x402 docs](https://docs.x402.org/).

## API reference

- OpenAPI: https://www.nftdata.app/openapi.json
- Docs: https://www.nftdata.app/docs
