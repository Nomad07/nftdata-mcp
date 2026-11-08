// Test-only preload: replaces globalThis.fetch BEFORE server.ts loads, so the real server, the
// real x402 SDK and the real mppx SDK all run against a scripted, offline stand-in for the
// NFT Data API. No network access, no chain access, nothing is ever settled or broadcast.
//
// Configuration (env): MOCK_API_SCENARIO (JSON, see Scenario), MOCK_API_LOG (JSONL file path).
import { appendFileSync } from "node:fs";
import { register } from "node:module";
import { Challenge, Credential, Expires, Receipt } from "mppx";
import { OFFICIAL_ENDPOINT, OFFICIAL_PAY_TO, USDC_BASE } from "../../lib.js";
import { MOCK_SIGNATURE } from "./mock-signer.js";
import { TX_HASH, type Scenario } from "./shared.js";

// Redirect the server's "viem/accounts" import to the mock signer BEFORE server.ts loads.
// With the all-zero test key the real implementation would throw, so if this redirect ever
// failed to engage the server would refuse to start instead of signing anything.
register("./mock-accounts-hooks.mjs", {
  parentURL: import.meta.url,
  data: { mockUrl: new URL("./mock-viem-accounts.ts", import.meta.url).href },
});

const scenario: Scenario = JSON.parse(process.env.MOCK_API_SCENARIO ?? "{}");
const logPath = process.env.MOCK_API_LOG ?? "";
let challengeCounter = 0;

const log = (entry: Record<string, unknown>) => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
};

const terms = () => ({
  amount: scenario.terms?.amount ?? "2000",
  payTo: scenario.terms?.payTo ?? OFFICIAL_PAY_TO,
  asset: scenario.terms?.asset ?? USDC_BASE,
  chainId: scenario.terms?.chainId ?? 8453,
});

function challengeHeaders(): Headers {
  const h = new Headers({ "Content-Type": "application/json" });
  const t = terms();
  const offers = scenario.offers ?? "both";
  if (offers !== "mpp") {
    const required = {
      x402Version: 2,
      error: "Payment required",
      resource: { url: OFFICIAL_ENDPOINT, description: "NFT Data", mimeType: "application/json" },
      accepts: [
        {
          scheme: "exact",
          network: `eip155:${t.chainId}`,
          asset: t.asset,
          amount: t.amount,
          payTo: t.payTo,
          maxTimeoutSeconds: 300,
          extra: { name: "USD Coin", version: "2" },
        },
      ],
    };
    h.set("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(required)).toString("base64"));
  }
  if (offers !== "x402") {
    const challenge = Challenge.from({
      id: `mock-challenge-${++challengeCounter}`,
      realm: "www.nftdata.app",
      method: "evm",
      intent: "charge",
      expires: Expires.minutes(5),
      request: {
        amount: t.amount,
        currency: t.asset,
        recipient: t.payTo,
        methodDetails: { chainId: t.chainId, credentialTypes: ["authorization"], decimals: 6 },
      },
    });
    h.set("WWW-Authenticate", Challenge.serialize(challenge));
  }
  return h;
}

interface Seen {
  credential: "none" | "x402" | "mpp" | "both";
  valid: boolean;
  value?: string;
  to?: string;
}

function inspect(req: Request): Seen {
  const x402 = req.headers.get("payment-signature") ?? req.headers.get("x-payment");
  const auth = req.headers.get("authorization");
  const mpp = auth !== null && /^payment\s/i.test(auth) ? auth : null;
  if (x402 && mpp) return { credential: "both", valid: false };
  if (x402) {
    try {
      const body = JSON.parse(Buffer.from(x402, "base64").toString("utf8"));
      const a = body?.payload?.authorization;
      const value = String(a?.value);
      const to = String(a?.to);
      const sig = String(body?.payload?.signature ?? "");
      return {
        credential: "x402",
        valid: value === "2000" && to.toLowerCase() === OFFICIAL_PAY_TO && sig === MOCK_SIGNATURE,
        value,
        to,
      };
    } catch {
      return { credential: "x402", valid: false };
    }
  }
  if (mpp) {
    try {
      const cred = Credential.deserialize<{ value?: string; to?: string; signature?: string }>(mpp);
      const { value = "", to = "", signature = "" } = cred.payload;
      return {
        credential: "mpp",
        valid:
          cred.challenge.method === "evm" &&
          value === "2000" &&
          to.toLowerCase() === OFFICIAL_PAY_TO &&
          signature === MOCK_SIGNATURE,
        value,
        to,
      };
    } catch {
      return { credential: "mpp", valid: false };
    }
  }
  return { credential: "none", valid: false };
}

const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const req = new Request(input, init);
  if (req.url !== OFFICIAL_ENDPOINT) {
    log({ kind: "unexpected-url", url: req.url });
    throw new Error("mock API: unexpected URL");
  }
  const slug = (JSON.parse(await req.text()) as { collection?: string }).collection ?? "";
  const seen = inspect(req);
  const entry = { kind: "request", slug, ...seen, executed: false };

  if (seen.credential === "none") {
    if (scenario.delayMs) await new Promise((r) => setTimeout(r, scenario.delayMs));
    log(entry);
    return new Response("{}", { status: 402, headers: challengeHeaders() });
  }
  if (!seen.valid || scenario.always402) {
    log(entry);
    return new Response("{}", { status: 402, headers: challengeHeaders() });
  }
  if (scenario.paidStatus) {
    log(entry);
    return new Response("{}", { status: scenario.paidStatus });
  }

  log({ ...entry, executed: true });
  const headers = new Headers({ "Content-Type": "application/json" });
  if (seen.credential === "x402") {
    const settle = { success: true, transaction: TX_HASH, network: "eip155:8453", payer: "0x" + "00".repeat(20) };
    headers.set("PAYMENT-RESPONSE", Buffer.from(JSON.stringify(settle)).toString("base64"));
  } else {
    headers.set(
      "Payment-Receipt",
      Receipt.serialize(
        Receipt.from({ method: "evm", reference: TX_HASH, status: "success", timestamp: new Date().toISOString() }),
      ),
    );
  }
  return new Response(JSON.stringify({ name: slug, floor_price: 1.5 }), { status: 200, headers });
};

globalThis.fetch = mockFetch as typeof fetch;
