import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_MAINNET,
  CACHE_TTL_MS,
  CachedFetcher,
  EXACT_AMOUNT_ATOMIC,
  OFFICIAL_ENDPOINT,
  OFFICIAL_PAY_TO,
  REFUSAL_PREFIX,
  SpendLimiter,
  TimeoutError,
  USDC_BASE,
  fail,
  isValidPrivateKey,
  mapError,
  mapResponse,
  normalizeSlug,
  ok,
  parseConfig,
  resolveEndpoint,
  validateRequirements,
  withTimeout,
} from "./lib.js";

const PAYTO = OFFICIAL_PAY_TO;
const goodReq = () => ({
  scheme: "exact",
  network: BASE_MAINNET,
  asset: USDC_BASE,
  amount: "2000",
  payTo: PAYTO,
});

// ---- slug validation / normalization
test("normalizeSlug lowercases and trims", () => {
  assert.equal(normalizeSlug("  AzUki "), "azuki");
  assert.equal(normalizeSlug("based-punks_2"), "based-punks_2");
});
test("normalizeSlug rejects invalid input", () => {
  for (const s of ["", "   ", "-azuki", "a b", "a/b", "a?x=1", "é", "a".repeat(101)]) {
    assert.equal(normalizeSlug(s), null, JSON.stringify(s));
  }
});

// ---- endpoint override
test("endpoint defaults to the official URL", () => {
  assert.equal(resolveEndpoint(undefined), OFFICIAL_ENDPOINT);
  assert.equal(resolveEndpoint(""), OFFICIAL_ENDPOINT);
});
test("endpoint override only accepts official NFT Data URLs", () => {
  assert.equal(resolveEndpoint("https://nftdata.app/api/get-collection-data"), "https://nftdata.app/api/get-collection-data");
  for (const bad of [
    "https://evil.example/api/get-collection-data",
    "http://www.nftdata.app/api/get-collection-data",
    "https://www.nftdata.app.evil.example/api/get-collection-data",
    "https://www.nftdata.app@evil.example/api/get-collection-data",
    "https://user:pw@www.nftdata.app/api/get-collection-data",
    "https://www.nftdata.app/api/other",
    "https://www.nftdata.app/api/get-collection-data?x=1",
    "not a url",
  ]) {
    assert.throws(() => resolveEndpoint(bad), /not an accepted/, bad);
  }
});

// ---- config / NFTDATA_MAX_REQUESTS
test("max requests defaults to 100", () => {
  assert.equal(parseConfig({}).maxRequests, 100);
});
test("max requests accepts 1..1000", () => {
  assert.equal(parseConfig({ NFTDATA_MAX_REQUESTS: "1" }).maxRequests, 1);
  assert.equal(parseConfig({ NFTDATA_MAX_REQUESTS: "1000" }).maxRequests, 1000);
});
test("max requests rejects invalid or effectively unlimited values", () => {
  for (const v of ["0", "-1", "1001", "1e9", "Infinity", "NaN", "abc", "10.5", "99999999999999999999"]) {
    assert.throws(() => parseConfig({ NFTDATA_MAX_REQUESTS: v }), /NFTDATA_MAX_REQUESTS/, v);
  }
});
test("timeout is validated", () => {
  assert.equal(parseConfig({}).timeoutMs, 15000);
  assert.equal(parseConfig({ NFTDATA_TIMEOUT_MS: "5000" }).timeoutMs, 5000);
  for (const v of ["0", "999", "60001", "x"]) {
    assert.throws(() => parseConfig({ NFTDATA_TIMEOUT_MS: v }), /NFTDATA_TIMEOUT_MS/, v);
  }
});
test("private key shape check never throws and accepts only 0x+64 hex", () => {
  assert.equal(isValidPrivateKey("0x" + "1".repeat(64)), true);
  for (const k of [undefined, "", "0x123", "1".repeat(64), "0x" + "g".repeat(64)]) {
    assert.equal(isValidPrivateKey(k as string | undefined), false);
  }
});

// ---- payment challenge validation
test("accepts the expected Base USDC challenge", () => {
  assert.equal(validateRequirements(goodReq()), null);
  // Case-insensitive asset address is accepted when the amount is exactly 2000.
  assert.equal(validateRequirements({ ...goodReq(), asset: USDC_BASE.toLowerCase() }), null);
});
test("refuses wrong network, scheme, token, amount", () => {
  assert.match(validateRequirements({ ...goodReq(), network: "eip155:1" })!, /network/);
  assert.match(validateRequirements({ ...goodReq(), network: "eip155:84532" })!, /network/);
  assert.match(validateRequirements({ ...goodReq(), network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" })!, /network/);
  assert.match(validateRequirements({ ...goodReq(), scheme: "upto" })!, /scheme/);
  assert.match(validateRequirements({ ...goodReq(), asset: "0x" + "11".repeat(20) })!, /token/);
  // Any amount other than exactly 2000 is refused.
  assert.match(validateRequirements({ ...goodReq(), amount: "2001" })!, /does not match/);
  assert.match(validateRequirements({ ...goodReq(), amount: "10000" })!, /does not match/);
  assert.match(validateRequirements({ ...goodReq(), amount: "1999" })!, /does not match/);
  assert.match(validateRequirements({ ...goodReq(), amount: "1" })!, /does not match/);
  assert.match(validateRequirements({ ...goodReq(), amount: "0" })!, /does not match/);
  // Malformed amount strings are caught before the value comparison.
  for (const a of ["-1", "1.5", "", "0x10", "1e3", " 5"]) {
    assert.match(validateRequirements({ ...goodReq(), amount: a })!, /invalid payment amount/, a);
  }
});
test("refuses malformed recipient", () => {
  assert.match(validateRequirements({ ...goodReq(), payTo: "0x123" })!, /recipient/);
});
test("recipient must be the official NFT Data address (case-insensitive)", () => {
  assert.equal(validateRequirements({ ...goodReq(), payTo: "0x344143199642E87320785823C20c2df107D17534" }), null);
  assert.match(validateRequirements({ ...goodReq(), payTo: "0x" + "cd".repeat(20) })!, /unexpected payment recipient/);
});

// ---- request limit
test("SpendLimiter enforces the limit and supports release", () => {
  const l = new SpendLimiter(2);
  assert.equal(l.tryReserve(), true);
  assert.equal(l.tryReserve(), true);
  assert.equal(l.tryReserve(), false);
  l.release();
  assert.equal(l.tryReserve(), true);
  assert.equal(l.used, 2);
});

// ---- cache + in-flight dedupe
test("cache returns the stored body within the TTL and reloads after it", async () => {
  let t = 0;
  let calls = 0;
  const f = new CachedFetcher(async () => { calls++; return ok(`{"n":${calls}}`); }, () => t);
  assert.equal((await f.get("azuki")).content[0].text, '{"n":1}');
  t = CACHE_TTL_MS - 1;
  assert.equal((await f.get("azuki")).content[0].text, '{"n":1}');
  assert.equal(calls, 1);
  t = CACHE_TTL_MS + 1;
  assert.equal((await f.get("azuki")).content[0].text, '{"n":2}');
  assert.equal(calls, 2);
});
test("concurrent identical requests share one load (no duplicate paid request)", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const f = new CachedFetcher(async () => { calls++; await gate; return ok("{}"); });
  const a = f.get("azuki");
  const b = f.get("azuki");
  const c = f.get("milady");
  release();
  await Promise.all([a, b, c]);
  assert.equal(calls, 2); // one for azuki, one for milady
});
test("failures are not cached and in-flight entry is cleared", async () => {
  let calls = 0;
  const f = new CachedFetcher(async () => { calls++; return calls === 1 ? fail("x") : ok("{}"); });
  assert.equal((await f.get("a")).isError, true);
  assert.equal((await f.get("a")).isError, undefined);
  assert.equal(calls, 2);
});

// ---- timeout
test("withTimeout rejects with TimeoutError and aborts the signal", async () => {
  let aborted = false;
  await assert.rejects(
    withTimeout((signal) => new Promise<never>(() => { signal.addEventListener("abort", () => { aborted = true; }); }), 20),
    TimeoutError,
  );
  assert.equal(aborted, true);
});
test("withTimeout passes through fast results", async () => {
  assert.equal(await withTimeout(async () => 7, 1000), 7);
});
test("timeout error message does not claim the payment failed and is not retried", () => {
  const r = mapError(new TimeoutError("timeout"));
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /timed out/);
  assert.match(r.content[0].text, /not retried/);
});

// ---- error / response mapping
test("mapError exposes only our own policy refusals, never raw error text", () => {
  const refusal = mapError(new Error(`Payment creation aborted: ${REFUSAL_PREFIX}unexpected payment network`));
  assert.match(refusal.content[0].text, /unexpected payment network/);
  const secret = mapError(new Error("boom 0x" + "1".repeat(64) + " at https://internal"));
  assert.equal(secret.content[0].text, "The request failed.");
});
test("mapResponse handles 200/400/404/429/402/other", () => {
  assert.equal(mapResponse(200, '{"a":1}', null).isError, undefined);
  assert.equal(mapResponse(200, "<html>", null).isError, true);
  assert.match(mapResponse(400, "secret detail", null).content[0].text, /Invalid collection slug/);
  assert.doesNotMatch(mapResponse(400, "secret detail", null).content[0].text, /secret/);
  assert.match(mapResponse(404, "", null).content[0].text, /not found/);
  assert.match(mapResponse(429, "", "12").content[0].text, /12 seconds/);
  assert.match(mapResponse(429, "", "<script>").content[0].text, /a few seconds/);
  assert.match(mapResponse(402, "payTo 0xabc", null).content[0].text, /not accepted/);
  assert.doesNotMatch(mapResponse(500, "stack trace", null).content[0].text, /stack/);
});

// ---- validateRequirements: exact amount enforcement
// The API price is fixed at $0.002 = 2000 atomic units of Base USDC.
// Only the challenge amount "2000" is accepted; everything else is refused.
test("validateRequirements: only exact amount 2000 is accepted", () => {
  // The four boundary values specified in the task:
  assert.match(validateRequirements({ ...goodReq(), amount: "0" })!,    /does not match/);
  assert.match(validateRequirements({ ...goodReq(), amount: "1999" })!, /does not match/);
  assert.equal(validateRequirements({ ...goodReq(), amount: "2000" }), null);   // only passing value
  assert.match(validateRequirements({ ...goodReq(), amount: "2001" })!, /does not match/);
  // Additional values that must be refused.
  assert.match(validateRequirements({ ...goodReq(), amount: "1" })!,    /does not match/);
  assert.match(validateRequirements({ ...goodReq(), amount: "10000" })!, /does not match/);
  // EXACT_AMOUNT_ATOMIC is 2000n; verify the constant is still 2000.
  assert.equal(EXACT_AMOUNT_ATOMIC, 2000n);
  // Malformed strings are caught by the format check before the value comparison.
  for (const a of [" 2000", "2000 ", "2000.0", "-1", "0x7D0", "2e3"]) {
    assert.match(validateRequirements({ ...goodReq(), amount: a })!, /invalid payment amount/,
      `expected format rejection for amount=${JSON.stringify(a)}`);
  }
});

// ---- SpendLimiter: release does not go below zero
test("SpendLimiter: release is a no-op when already at zero", () => {
  const l = new SpendLimiter(3);
  l.release(); // should not throw or underflow
  assert.equal(l.used, 0);
  assert.equal(l.tryReserve(), true); // still works normally after spurious release
  assert.equal(l.used, 1);
});

// ---- hook abort propagation: error message carries the REFUSAL_PREFIX
test("onBeforePaymentCreation abort produces error text that mapError can extract", () => {
  // Simulate what the SDK does when a hook returns { abort: true, reason: "..." }:
  //   throw new Error(`Payment creation aborted: ${result.reason}`)
  // Verify mapError recognises the REFUSAL_PREFIX embedded in that message.
  const reason = `${REFUSAL_PREFIX}unexpected payment network`;
  const thrown = new Error(`Payment creation aborted: ${reason}`);
  const result = mapError(thrown);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /unexpected payment network/);
  // Must not leak the raw SDK error wrapper text
  assert.doesNotMatch(result.content[0].text, /Payment creation aborted/);
});

test("onBeforePaymentCreation abort for limit reached produces extractable message", () => {
  const reason = `${REFUSAL_PREFIX}paid request limit (100) for this session reached`;
  const thrown = new Error(`Payment creation aborted: ${reason}`);
  const result = mapError(thrown);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /paid request limit/);
  assert.match(result.content[0].text, /100/);
});

// ---- PaymentCreationContext field names match validateRequirements interface
// The SDK's PaymentRequirements type has: scheme, network, asset, amount, payTo.
// validateRequirements reads exactly those field names.  This test confirms the
// mapping is correct by constructing an object identical in shape to what the
// SDK passes as ctx.selectedRequirements and verifying the validator accepts it.
test("validateRequirements field names match the SDK PaymentRequirements shape", () => {
  // Construct with the same field names the SDK uses (confirmed from type definitions).
  const sdkStyleReq = {
    scheme: "exact",
    network: BASE_MAINNET as `${string}:${string}`,
    asset: USDC_BASE,
    amount: "2000",
    payTo: OFFICIAL_PAY_TO,
    maxTimeoutSeconds: 60,                  // extra SDK field not read by validator
    extra: {} as Record<string, unknown>,   // extra SDK field not read by validator
  };
  assert.equal(validateRequirements(sdkStyleReq), null);
  // Wrong network via the same shape
  assert.match(
    validateRequirements({ ...sdkStyleReq, network: "eip155:1" as `${string}:${string}` })!,
    /network/,
  );
});
