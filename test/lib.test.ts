import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_MAINNET,
  CACHE_TTL_MS,
  CachedFetcher,
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
} from "../lib.js";

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
  assert.equal(validateRequirements({ ...goodReq(), amount: "1" }), null);
  assert.equal(validateRequirements({ ...goodReq(), asset: USDC_BASE.toLowerCase() }), null);
});
test("refuses wrong network, scheme, token, amount", () => {
  assert.match(validateRequirements({ ...goodReq(), network: "eip155:1" })!, /network/);
  assert.match(validateRequirements({ ...goodReq(), network: "eip155:84532" })!, /network/);
  assert.match(validateRequirements({ ...goodReq(), network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" })!, /network/);
  assert.match(validateRequirements({ ...goodReq(), scheme: "upto" })!, /scheme/);
  assert.match(validateRequirements({ ...goodReq(), asset: "0x" + "11".repeat(20) })!, /token/);
  assert.match(validateRequirements({ ...goodReq(), amount: "2001" })!, /above/);
  assert.match(validateRequirements({ ...goodReq(), amount: "10000" })!, /above/);
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
