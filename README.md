# nftdata-mcp

An MCP server that exposes the [NFT Data](https://www.nftdata.app/) API to AI clients such as Claude Desktop as a single tool: `get_collection_data`. Each API request is paid automatically with **$0.002 in USDC on Base** via the [x402](https://docs.x402.org/) protocol.

- **npm:** https://www.npmjs.com/package/nftdata-mcp
- **MCP Registry:** https://registry.modelcontextprotocol.io/?q=nftdata
- **NFT Data GitHub:** https://github.com/Nomad07/nft-data

---

## Prerequisites

- **Node.js 20 or newer** (required by the x402 SDK)
- **A dedicated wallet** funded with a small amount of USDC on Base mainnet

> Always use a dedicated wallet with only a small balance. Never use your primary wallet or share its private key.

---

## Claude Desktop setup

Add the following block to `claude_desktop_config.json` (usually found in `~/Library/Application Support/Claude/` on macOS or `%APPDATA%\Claude\` on Windows):

```json
{
  "mcpServers": {
    "nftdata": {
      "command": "npx",
      "args": ["-y", "nftdata-mcp@1.0.2"],
      "env": {
        "EVM_PRIVATE_KEY": "YOUR_EVM_PRIVATE_KEY"
      }
    }
  }
}
```

Replace `YOUR_EVM_PRIVATE_KEY` with the private key of your dedicated wallet (`0x` followed by 64 hex characters). Then restart Claude Desktop.

The server communicates over **stdio** and is launched automatically by Claude Desktop. Running it by hand shows no output; it waits for an MCP client to connect.

---

## First query

After restarting Claude Desktop:

1. Open a new conversation.
2. To make sure Claude selects the right server when you have multiple MCP servers configured, start with an explicit request:

   > Use the NFT Data MCP server to look up an NFT collection.

3. When Claude asks for a collection slug, enter:

   > Azuki

4. Continue with natural follow-up questions. If Claude does not use the NFT Data server, ask it explicitly to do so.

You can also ask directly by collection name or OpenSea slug. Claude will retrieve the latest collection statistics, including floor price, sales volume, owner count, supply, and lifetime metrics. Each successful request includes a payment transaction hash and a BaseScan verification link.

---

## Example: Azuki collection report

The following is an example response from one query. Market data changes continuously; these values are from a specific query and are not current live data.

**Collection overview**

| Field | Value |
|---|---|
| Name | Azuki |
| Slug | `azuki` |
| Chain | Ethereum |
| Contract | `0xed5af388653567af2f388e6224dc7c4b3241c544` |
| Created | January 12, 2022 |
| Total supply | 10,000 |
| Unique owners | 4,394 |
| Floor price | 0.4933 ETH |

**Market activity**

| Period | Sales | Volume |
|---|---|---|
| 24 hours | 21 | 10.15 ETH |
| 7 days | 163 | 96.68 ETH |
| 30 days | 471 | 325.72 ETH |
| Lifetime | 93,156 | 831,992.65 ETH |

**Payment**

| Field | Value |
|---|---|
| Cost | $0.002 |
| Protocol | x402 |
| Transaction | [`0x4fb3...580f8`](https://basescan.org/tx/0x4fb35acc31a9f6841647ca2533a7f9ac7113f54364e979b8de4786bf1de580f8) |

---

## Customize your results

The server supplies the underlying collection data returned by the API. Claude can organize that information in the format you prefer, from a concise summary to a detailed report, tables, or comparisons. Simply ask Claude how you want the results presented. This changes the presentation, not the source values.

---

## Raw request and response

Claude Desktop may show the tool request and returned data through its tool-activity details (the exact label varies by client version).

**Tool request**

```json
{ "collection": "azuki" }
```

<details>
<summary>Full raw response</summary>

```json
{
  "name": "Azuki",
  "slug": "azuki",
  "contracts": [
    {
      "address": "0xed5af388653567af2f388e6224dc7c4b3241c544",
      "chain": "ethereum"
    }
  ],
  "floor_price": 0.49328599,
  "floor_price_currency": "ETH",
  "one_day_sales": 21,
  "one_day_volume": 10.150091000000002,
  "seven_day_sales": 163,
  "seven_day_volume": 96.67526161112121,
  "thirty_day_sales": 471,
  "thirty_day_volume": 325.72023569476767,
  "total_sales": 93156,
  "total_volume": 831992.6461159982,
  "num_owners": 4394,
  "total_supply": 10000,
  "created_date": "2022-01-12",
  "one_day_volume_currency": "ETH",
  "seven_day_volume_currency": "ETH",
  "thirty_day_volume_currency": "ETH",
  "total_volume_currency": "ETH"
}
```

Raw floating-point values have more decimal places than the rounded values in the report above.

</details>

**Payment verification**

Transaction hash: `0x4fb35acc31a9f6841647ca2533a7f9ac7113f54364e979b8de4786bf1de580f8`

Verify on BaseScan: https://basescan.org/tx/0x4fb35acc31a9f6841647ca2533a7f9ac7113f54364e979b8de4786bf1de580f8

---

## Data networks vs. payment network

### Payment Protocols and Supported Networks

| Product | Payment Protocols | Payment Networks |
|---|---|---|
| NFT Data (website/API) | x402 and MPP | x402 — Base and Solana; MPP — Base |
| NFT Data (MCP server) | x402 | Base |

> **Note:** The NFT Data website/API and the NFT Data MCP server have different payment capabilities. The MCP server currently supports x402 payments on Base only; MPP support is not implemented in this package.

**Data network** refers to the blockchain where an NFT collection exists. NFT Data is a multichain service supporting NFT collections across **30+ blockchain networks** through the NFT Data API's OpenSea integration, including Ethereum, Base, Ink, Arc, HyperEVM, Robinhood Chain, and Solana, among others. OpenSea continues to expand its supported blockchain networks, so coverage may grow over time. The data network is independent of the payment network used to pay for API requests.

**Payment network** refers to the blockchain used to pay for each API request. This server pays on **Base mainnet only**, using USDC via x402, regardless of which chain the queried collection is on.

---

## x402 and payment verification

Each request is paid automatically using the [x402 protocol](https://docs.x402.org/) over Base mainnet. The payment flow:

1. The server sends the API request.
2. The API responds with HTTP 402 and a payment challenge.
3. Before signing, the server validates the challenge:
   - Scheme: `exact`
   - Network: Base mainnet (`eip155:8453`)
   - Token: USDC on Base (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
   - Amount: exactly 2000 atomic units ($0.002)
   - Recipient: `0x344143199642e87320785823c20c2df107d17534`
4. If everything matches, the wallet signs and submits the payment.
5. The API fulfills the request and returns the collection data along with the on-chain transaction hash.

Every successful response includes:

```
Payment: 0x...
Verify: https://basescan.org/tx/0x...
```

This server supports **x402 on Base only**. Solana and MPP payment methods are not implemented.

---

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `EVM_PRIVATE_KEY` | yes | — | Private key (`0x` + 64 hex chars) of the wallet that pays for calls |
| `NFTDATA_MAX_REQUESTS` | no | `100` | Max signed payments per session. Integer 1–1000; any other value stops startup with an error |
| `NFTDATA_TIMEOUT_MS` | no | `15000` | Request timeout in milliseconds (1000–60000) |
| `NFTDATA_URL` | no | `https://www.nftdata.app/api/get-collection-data` | Accepts only the official NFT Data endpoint; anything else stops startup |

---

## Behavior

- Sends `POST /api/get-collection-data` with body `{"collection": "<slug>"}`.
- The slug is trimmed and lowercased, then must match `^[a-z0-9][a-z0-9_-]*$` (max 100 characters); otherwise no request is made.
- Each signed payment counts against `NFTDATA_MAX_REQUESTS`, including payments for requests that later fail or time out.
- No automatic retries: one tool call makes at most one payment attempt.
- Successful responses are cached for 5 minutes per slug. Concurrent identical calls share a single in-flight request.
- Cache hits do not include a payment transaction hash (no new payment was made).
- Returns generic errors for `400` (invalid slug), `404` (collection not found), `429` (rate limit, with retry delay), timeouts, and other failures. Server and payment details are not exposed to the MCP client.

---

## Troubleshooting

**Server does not appear in Claude Desktop**
Verify the `claude_desktop_config.json` path, check for JSON syntax errors, and restart Claude Desktop fully.

**`EVM_PRIVATE_KEY is missing or malformed`**
The key must be `0x` followed by exactly 64 hex characters. Check for extra whitespace or a missing `0x` prefix.

**`paid request limit ... reached`**
The session has reached `NFTDATA_MAX_REQUESTS`. Restart Claude Desktop to reset the counter, or set a higher limit.

**Request timed out**
A payment may have been signed before the timeout. The server does not retry automatically.

**Imports fail after an SDK update**
The x402 SDK changes frequently. Check the [x402 docs](https://docs.x402.org/) and the [nftdata-mcp changelog](https://github.com/Nomad07/nftdata-mcp/releases) for the latest compatible version.

---

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

To use a local checkout with Claude Desktop, set `"command": "npx"` and `"args": ["tsx", "/absolute/path/to/nftdata-mcp/server.ts"]`.

---

## Build and test

```bash
npm run build   # compiles to dist/
npm test        # offline unit tests, no network and no payments
```

---

## Links

- [NFT Data website](https://www.nftdata.app/)
- [NFT Data API docs](https://www.nftdata.app/docs)
- [NFT Data OpenAPI spec](https://www.nftdata.app/openapi.json)
- [x402 protocol docs](https://docs.x402.org/)
- [BaseScan](https://basescan.org/)
- [nftdata-mcp on npm](https://www.npmjs.com/package/nftdata-mcp)
- [nftdata-mcp in the MCP Registry](https://registry.modelcontextprotocol.io/?q=nftdata)

---

## Limitations

- Only x402 on Base mainnet is supported for payments. Solana and MPP are not implemented.
- The expected recipient address is hardcoded. If the NFT Data payout address changes, update `OFFICIAL_PAY_TO` in `lib.ts` and release a new version.
- The payment hook depends on the installed `@x402/*` SDK and is not covered by the offline unit tests.
- The x402 SDK changes quickly. If imports fail, check the [x402 docs](https://docs.x402.org/).
