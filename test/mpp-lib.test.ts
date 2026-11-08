import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OFFICIAL_PAY_TO,
  USDC_BASE,
  parseConfig,
  parseProtocol,
  validateMppChallenge,
  type MppChallengeLike,
} from "../lib.js";

// A native MPP EVM charge challenge as delivered by the mppx client.
const goodChallenge = (): MppChallengeLike => ({
  id: "abc123",
  method: "evm",
  intent: "charge",
  request: {
    amount: "2000",
    currency: USDC_BASE,
    recipient: OFFICIAL_PAY_TO,
    methodDetails: { chainId: 8453, credentialTypes: ["authorization"], decimals: 6 },
  },
});

const withRequest = (patch: Record<string, unknown>): MppChallengeLike => {
  const c = goodChallenge();
  return { ...c, request: { ...c.request, ...patch } };
};

const withDetails = (patch: Record<string, unknown>): MppChallengeLike => {
  const c = goodChallenge();
  const details = c.request.methodDetails as Record<string, unknown>;
  return { ...c, request: { ...c.request, methodDetails: { ...details, ...patch } } };
};

// --- protocol selection -------------------------------------------------------------------

test("protocol defaults to x402 when unset or empty", () => {
  assert.equal(parseProtocol(undefined), "x402");
  assert.equal(parseProtocol(""), "x402");
  assert.equal(parseProtocol("   "), "x402");
  assert.equal(parseConfig({}).protocol, "x402");
  assert.equal(parseConfig({ NFTDATA_PAYMENT_PROTOCOL: "" }).protocol, "x402");
});

test("protocol accepts exactly x402 or mpp (trimmed, case-insensitive)", () => {
  assert.equal(parseProtocol("x402"), "x402");
  assert.equal(parseProtocol("mpp"), "mpp");
  assert.equal(parseProtocol(" MPP "), "mpp");
  assert.equal(parseProtocol("X402"), "x402");
  assert.equal(parseConfig({ NFTDATA_PAYMENT_PROTOCOL: "mpp" }).protocol, "mpp");
});

test("invalid, ambiguous or multi-protocol values are rejected at startup", () => {
  for (const v of ["auto", "both", "x402,mpp", "mpp,x402", "x402|mpp", "mpp x402", "tempo", "solana", "0", "true", "mppx"]) {
    assert.throws(() => parseProtocol(v), /NFTDATA_PAYMENT_PROTOCOL/, v);
    assert.throws(() => parseConfig({ NFTDATA_PAYMENT_PROTOCOL: v }), /NFTDATA_PAYMENT_PROTOCOL/, v);
  }
});

test("existing config parsing is unaffected by the protocol setting", () => {
  const c = parseConfig({ NFTDATA_MAX_REQUESTS: "5", NFTDATA_TIMEOUT_MS: "2000", NFTDATA_PAYMENT_PROTOCOL: "mpp" });
  assert.equal(c.maxRequests, 5);
  assert.equal(c.timeoutMs, 2000);
});

// --- MPP payment-term validation ----------------------------------------------------------

test("accepts the expected Base USDC MPP challenge, case-insensitively", () => {
  assert.equal(validateMppChallenge(goodChallenge()), null);
  assert.equal(
    validateMppChallenge(withRequest({ currency: USDC_BASE.toLowerCase(), recipient: OFFICIAL_PAY_TO.toUpperCase().replace("0X", "0x") })),
    null,
  );
});

test("refuses any amount other than exactly 2000 atomic units", () => {
  for (const amount of ["1999", "2001", "0", "20000", "2000.0", "-2000", "", "0x7d0", " 2000"]) {
    assert.notEqual(validateMppChallenge(withRequest({ amount })), null, amount);
  }
  assert.notEqual(validateMppChallenge(withRequest({ amount: 2000 })), null);
});

test("refuses wrong chain, token, decimals or recipient", () => {
  assert.match(validateMppChallenge(withDetails({ chainId: 1 }))!, /network/);
  assert.match(validateMppChallenge(withDetails({ chainId: "8453" }))!, /network/);
  assert.match(validateMppChallenge(withDetails({ chainId: 84532 }))!, /network/);
  assert.match(validateMppChallenge(withRequest({ currency: "0x" + "11".repeat(20) }))!, /token/);
  assert.match(validateMppChallenge(withDetails({ decimals: 18 }))!, /token/);
  assert.match(validateMppChallenge(withRequest({ recipient: "0x" + "22".repeat(20) }))!, /recipient/);
  assert.match(validateMppChallenge(withRequest({ recipient: "not-an-address" }))!, /recipient/);
});

test("refuses other methods, intents and missing structure", () => {
  assert.notEqual(validateMppChallenge({ ...goodChallenge(), method: "tempo" }), null);
  assert.notEqual(validateMppChallenge({ ...goodChallenge(), intent: "session" }), null);
  assert.notEqual(validateMppChallenge({ ...goodChallenge(), request: {} }), null);
  assert.notEqual(validateMppChallenge(withRequest({ methodDetails: undefined })), null);
  assert.notEqual(validateMppChallenge(withDetails({ credentialTypes: [] })), null);
  assert.notEqual(validateMppChallenge(withDetails({ credentialTypes: undefined })), null);
});

test("refuses payment splits", () => {
  assert.match(
    validateMppChallenge(withDetails({ splits: [{ amount: "1000", recipient: OFFICIAL_PAY_TO }] }))!,
    /splits/,
  );
  assert.equal(validateMppChallenge(withDetails({ splits: [] })), null);
});

test("refuses challenges that originate from x402 PAYMENT-REQUIRED headers", () => {
  // Synthetic x402-derived challenge: "x402:" id and scheme/network instead of methodDetails.
  const x402Derived: MppChallengeLike = {
    id: "x402:0",
    method: "evm",
    intent: "charge",
    request: { scheme: "exact", network: "eip155:8453", asset: USDC_BASE, amount: "2000", payTo: OFFICIAL_PAY_TO },
  };
  assert.notEqual(validateMppChallenge(x402Derived), null);
  // Even if it also carried a native-looking shape, the id prefix alone must reject it.
  assert.notEqual(validateMppChallenge({ ...goodChallenge(), id: "x402:0" }), null);
  // And scheme/network fields alone must reject it.
  assert.notEqual(validateMppChallenge(withRequest({ scheme: "exact" })), null);
  assert.notEqual(validateMppChallenge(withRequest({ network: "eip155:8453" })), null);
});

test("never throws on hostile input", () => {
  for (const bad of [null, undefined, 1, "x", [], { request: null }, { method: "evm", intent: "charge", id: "a", request: [] }]) {
    assert.doesNotThrow(() => validateMppChallenge(bad as unknown as MppChallengeLike));
    assert.notEqual(validateMppChallenge(bad as unknown as MppChallengeLike), null);
  }
});
