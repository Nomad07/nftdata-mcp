// End-to-end tests of the real server.ts payment path (x402 and MPP) against a scripted mock API
// and a mock signer. Each case starts the real server as a child process; see helpers/harness.ts.
// No real payments, no cryptographic signing, no network: "signing" returns a fixed constant and
// the test inspects exactly what the server asked the signer to sign.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OFFICIAL_PAY_TO, USDC_BASE } from "../lib.js";
import {
  credentialed,
  executed,
  requests,
  signs,
  startServerExpectingExit,
  unexpected,
  withServer,
  type Protocol,
} from "./helpers/harness.js";
import { TX_HASH, type Scenario } from "./helpers/shared.js";

const PROTOCOLS: Protocol[] = ["x402", "mpp"];
const protocolEnv = (p: Protocol) => (p === "mpp" ? "mpp" : undefined);
const other = (p: Protocol): Protocol => (p === "mpp" ? "x402" : "mpp");

// --- protocol selection -----------------------------------------------------------------

for (const [raw, expected] of [
  [undefined, "x402"],
  ["", "x402"],
  ["   ", "x402"],
  ["x402", "x402"],
  [" X402 ", "x402"],
  ["mpp", "mpp"],
  ["MPP", "mpp"],
] as const) {
  test(`NFTDATA_PAYMENT_PROTOCOL=${JSON.stringify(raw)} selects ${expected}`, async () => {
    await withServer({ protocolEnv: raw }, async (s) => {
      const r = await s.call("azuki");
      assert.equal(r.isError, false, r.text);
      const paid = credentialed(s.log());
      assert.equal(paid.length, 1);
      assert.equal(paid[0].credential, expected);
      assert.equal(signs(s.log()).length, 1, "exactly one signing request");
    });
  });
}

for (const bad of ["auto", "both", "x402,mpp", "mpp,x402", "tempo", "solana"]) {
  test(`invalid NFTDATA_PAYMENT_PROTOCOL=${JSON.stringify(bad)} fails at startup without any request`, () => {
    const r = startServerExpectingExit({ protocolEnv: bad });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /NFTDATA_PAYMENT_PROTOCOL/);
    assert.equal(r.log.length, 0);
  });
}

// --- per-protocol payment behaviour -----------------------------------------------------

for (const p of PROTOCOLS) {
  test(`${p}: one call pays once, with ${p} only, at the exact price to the official recipient`, async () => {
    // The mock's 402 offers BOTH protocols, like production.
    await withServer({ protocolEnv: protocolEnv(p) }, async (s) => {
      const r = await s.call("azuki");
      assert.equal(r.isError, false, r.text);
      assert.match(r.text, /"floor_price"/);
      assert.ok(r.text.includes(`Payment: ${TX_HASH}`), "receipt line with the settlement hash");
      assert.ok(r.text.includes(`https://basescan.org/tx/${TX_HASH}`));

      const log = s.log();
      assert.equal(requests(log).length, 2, "one unpaid probe plus one paid request");
      const paid = credentialed(log);
      assert.equal(paid.length, 1, "exactly one credential");
      assert.equal(paid[0].credential, p);
      assert.equal(paid[0].valid, true);
      assert.equal(paid[0].value, "2000");
      assert.equal(paid[0].to?.toLowerCase(), OFFICIAL_PAY_TO);
      assert.equal(requests(log).filter((e) => e.credential === other(p)).length, 0, `no ${other(p)} credential`);

      // The exact parameters the server asked the signer to sign, checked at the signing boundary.
      const signed = signs(log);
      assert.equal(signed.length, 1, "the signer was asked exactly once");
      assert.equal(signed[0].primaryType, "TransferWithAuthorization");
      assert.equal(signed[0].message?.value, "2000", "exactly $0.002 in USDC atomic units");
      assert.equal(signed[0].message?.to?.toLowerCase(), OFFICIAL_PAY_TO, "official recipient");
      assert.equal(signed[0].domain?.chainId, "8453", "Base mainnet");
      assert.equal(signed[0].domain?.verifyingContract?.toLowerCase(), USDC_BASE.toLowerCase(), "USDC on Base");
      assert.equal(executed(log).length, 1, "the paid operation ran exactly once");
      assert.equal(unexpected(log).length, 0, "no other network access");
    });
  });

  test(`${p}: refuses wrong payment terms before signing anything`, async () => {
    const variants: Scenario["terms"][] = [
      { amount: "2001" },
      { amount: "1999" },
      { payTo: `0x${"33".repeat(20)}` },
      { asset: `0x${"44".repeat(20)}` },
      { chainId: 1 },
    ];
    for (const terms of variants) {
      await withServer({ protocolEnv: protocolEnv(p), scenario: { terms } }, async (s) => {
        const r = await s.call("azuki");
        assert.equal(r.isError, true, JSON.stringify(terms));
        const log = s.log();
        assert.equal(signs(log).length, 0, `nothing signed for ${JSON.stringify(terms)}`);
        assert.equal(credentialed(log).length, 0, `no credential for ${JSON.stringify(terms)}`);
        assert.equal(requests(log).length, 1, "only the unpaid probe was sent");
        assert.equal(executed(log).length, 0);
      });
    }
  });

  test(`${p}: wrong amount is reported as a safety-policy refusal`, async () => {
    await withServer({ protocolEnv: protocolEnv(p), scenario: { terms: { amount: "2001" } } }, async (s) => {
      const r = await s.call("azuki");
      assert.match(r.text, /refused by safety policy/);
    });
  });

  test(`${p}: a repeated 402 after payment causes no second signature or payment attempt`, async () => {
    await withServer({ protocolEnv: protocolEnv(p), scenario: { always402: true } }, async (s) => {
      const r = await s.call("azuki");
      assert.equal(r.isError, true);
      assert.match(r.text, /Payment was not accepted/);
      const log = s.log();
      assert.equal(signs(log).length, 1, "the signer was asked exactly once, never a second time");
      assert.equal(credentialed(log).length, 1, "exactly one signed credential was sent");
      assert.equal(requests(log).length, 2, "probe plus a single paid attempt, no retry");
      assert.equal(executed(log).length, 0, "failed payment never executes the operation");
    });
  });

  test(`${p}: a server error after payment is not retried and does not execute`, async () => {
    await withServer({ protocolEnv: protocolEnv(p), scenario: { paidStatus: 500 } }, async (s) => {
      const r = await s.call("azuki");
      assert.equal(r.isError, true);
      const log = s.log();
      assert.equal(signs(log).length, 1);
      assert.equal(credentialed(log).length, 1);
      assert.equal(requests(log).length, 2);
      assert.equal(executed(log).length, 0);
    });
  });

  test(`${p}: only the other protocol on offer means no payment at all (no fallback)`, async () => {
    await withServer({ protocolEnv: protocolEnv(p), scenario: { offers: other(p) } }, async (s) => {
      const r = await s.call("azuki");
      assert.equal(r.isError, true);
      const log = s.log();
      assert.equal(signs(log).length, 0, "nothing was signed");
      assert.equal(credentialed(log).length, 0, "no credential was sent");
      assert.equal(requests(log).length, 1, "only the unpaid probe was sent");
      assert.equal(executed(log).length, 0);
    });
  });

  test(`${p}: the same slug within the cache window is served from cache without paying again`, async () => {
    await withServer({ protocolEnv: protocolEnv(p) }, async (s) => {
      const first = await s.call("azuki");
      const second = await s.call("azuki");
      assert.equal(first.isError, false);
      assert.equal(second.isError, false);
      assert.ok(first.text.includes("Payment:"));
      assert.ok(!second.text.includes("Payment:"), "cache hits carry no payment receipt");
      assert.equal(signs(s.log()).length, 1);
      assert.equal(credentialed(s.log()).length, 1);
      assert.equal(executed(s.log()).length, 1);
    });
  });

  test(`${p}: concurrent identical calls share one payment`, async () => {
    await withServer({ protocolEnv: protocolEnv(p), scenario: { delayMs: 150 } }, async (s) => {
      const results = await Promise.all(Array.from({ length: 5 }, () => s.call("azuki")));
      for (const r of results) assert.equal(r.isError, false, r.text);
      const log = s.log();
      assert.equal(signs(log).length, 1, "one signing request for five calls");
      assert.equal(credentialed(log).length, 1, "one credential for five calls");
      assert.equal(requests(log).length, 2);
      assert.equal(executed(log).length, 1);
    });
  });

  test(`${p}: the per-session spend limit stops further payments`, async () => {
    await withServer({ protocolEnv: protocolEnv(p), env: { NFTDATA_MAX_REQUESTS: "1" } }, async (s) => {
      const first = await s.call("azuki");
      const second = await s.call("doodles");
      assert.equal(first.isError, false, first.text);
      assert.equal(second.isError, true);
      assert.match(second.text, /limit \(1\)/);
      const log = s.log();
      assert.equal(signs(log).length, 1, "the second collection was never signed");
      assert.equal(credentialed(log).length, 1, "the second collection was never paid for");
      assert.equal(executed(log).length, 1);
    });
  });

  test(`${p}: an invalid slug never reaches the network`, async () => {
    await withServer({ protocolEnv: protocolEnv(p) }, async (s) => {
      const r = await s.call("bad slug!");
      assert.equal(r.isError, true);
      assert.equal(s.log().length, 0);
    });
  });
}

// --- MCP surface is unchanged -----------------------------------------------------------

test("tool name and input schema are unchanged; description mentions both protocols", async () => {
  await withServer({}, async (s) => {
    const { tools } = await s.client.listTools();
    assert.equal(tools.length, 1);
    const tool = tools[0];
    assert.equal(tool.name, "get_collection_data");
    assert.ok(tool.description?.includes("Costs $0.002 per call (x402 or MPP, USDC on Base)."));
    const schema = tool.inputSchema as {
      properties?: Record<string, { type?: string; maxLength?: number }>;
      required?: string[];
    };
    assert.deepEqual(Object.keys(schema.properties ?? {}), ["collection"]);
    assert.equal(schema.properties?.collection.type, "string");
    assert.equal(schema.properties?.collection.maxLength, 200);
    assert.deepEqual(schema.required, ["collection"]);
  });
});
