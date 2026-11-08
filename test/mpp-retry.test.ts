// Direct tests of the MPP payer's one-credential-per-call guarantee, using the real mppx SDK with
// a mock signer and a mocked fetch. No cryptographic signing (the signer returns a constant),
// no network (globalThis.fetch is replaced before the payer is created).
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Account } from "viem";
import { Challenge, Expires } from "mppx";
import { OFFICIAL_ENDPOINT, OFFICIAL_PAY_TO, REFUSAL_PREFIX, SpendLimiter, USDC_BASE } from "../lib.js";
import { createMppFetch } from "../mpp.js";
import { MOCK_SIGNATURE, createMockSigner, type SignCall } from "./helpers/mock-signer.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface ApiCall {
  paid: boolean;
}

// Installs a mock API that ALWAYS answers 402 with a fresh challenge (new id every time), no
// matter what credential it receives. This is the worst case for a retry loop: the server keeps
// asking for payment. Returns the log of requests it saw.
function installAlways402Api(amount = "2000"): ApiCall[] {
  const calls: ApiCall[] = [];
  let n = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    assert.equal(req.url, OFFICIAL_ENDPOINT, "only the official endpoint may be contacted");
    calls.push({ paid: /^payment\s/i.test(req.headers.get("authorization") ?? "") });
    const challenge = Challenge.from({
      id: `mock-challenge-${++n}`,
      realm: "www.nftdata.app",
      method: "evm",
      intent: "charge",
      expires: Expires.minutes(5),
      request: {
        amount,
        currency: USDC_BASE,
        recipient: OFFICIAL_PAY_TO,
        methodDetails: { chainId: 8453, credentialTypes: ["authorization"], decimals: 6 },
      },
    });
    return new Response("{}", { status: 402, headers: { "WWW-Authenticate": Challenge.serialize(challenge) } });
  }) as typeof fetch;
  return calls;
}

function setup(options: { sdkMaxPaymentRetries?: number; failSigning?: boolean } = {}) {
  const signs: SignCall[] = [];
  const signer = createMockSigner((call) => {
    if (options.failSigning) throw new Error("mock signer failure");
    signs.push(call);
  });
  const limiter = new SpendLimiter(10);
  const payFetch = createMppFetch({
    account: signer as unknown as Account,
    limiter,
    maxRequests: 10,
    sdkMaxPaymentRetries: options.sdkMaxPaymentRetries,
  });
  const call = () =>
    payFetch(OFFICIAL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collection: "azuki" }),
    });
  return { signs, limiter, call };
}

test("production setting (maxPaymentRetries: 1): a 402 after payment yields exactly one signed credential", async () => {
  const calls = installAlways402Api();
  const { signs, limiter, call } = setup();
  const res = await call();
  assert.equal(res.status, 402, "the repeated 402 is returned to the caller");
  assert.equal(signs.length, 1, "the signer was asked exactly once");
  assert.equal(calls.length, 2, "one unpaid probe plus one paid attempt, nothing more");
  assert.equal(calls.filter((c) => c.paid).length, 1, "exactly one request carried a credential");
  assert.equal(limiter.used, 1, "exactly one spend slot was used");
});

test("each call signs at most once, however many calls are made", async () => {
  const calls = installAlways402Api();
  const { signs, call } = setup();
  for (let i = 1; i <= 4; i++) {
    await call();
    assert.equal(signs.length, i, `after call ${i}: one more signature, never two`);
    assert.equal(calls.length, i * 2);
  }
});

test("the exact signed parameters are the expected price, recipient token and chain", async () => {
  installAlways402Api();
  const { signs, call } = setup();
  await call();
  assert.equal(signs.length, 1);
  assert.equal(signs[0].primaryType, "TransferWithAuthorization");
  assert.equal(signs[0].message.value, "2000");
  assert.equal(signs[0].message.to?.toLowerCase(), OFFICIAL_PAY_TO);
  assert.equal(signs[0].domain.chainId, "8453");
  assert.equal(signs[0].domain.verifyingContract?.toLowerCase(), USDC_BASE.toLowerCase());
});

test("the per-call guard alone also holds: even with a larger SDK retry budget, no second credential", async () => {
  // Not production configuration. It proves our own attempt guard does not depend on the SDK's
  // retry setting: the SDK is allowed 5 rounds and the API keeps demanding payment.
  const calls = installAlways402Api();
  const { signs, limiter, call } = setup({ sdkMaxPaymentRetries: 5 });
  await assert.rejects(call, (e: Error) => {
    assert.ok(e.message.includes(REFUSAL_PREFIX), e.message);
    assert.match(e.message, /only one payment attempt/);
    return true;
  });
  assert.equal(signs.length, 1, "still exactly one signature");
  assert.equal(calls.length, 2, "the second round was stopped before any request was sent");
  assert.equal(limiter.used, 1, "no second spend slot was reserved");
});

test("a refused offer signs nothing and reserves nothing", async () => {
  const calls = installAlways402Api("2001");
  const { signs, limiter, call } = setup();
  await assert.rejects(call, (e: Error) => e.message.includes(REFUSAL_PREFIX));
  assert.equal(signs.length, 0);
  assert.equal(calls.length, 1, "only the unpaid probe was sent");
  assert.equal(limiter.used, 0);
});

test("a signing failure releases the spend slot and sends no paid request", async () => {
  const calls = installAlways402Api();
  const { limiter, call } = setup({ failSigning: true });
  await assert.rejects(call, /mock signer failure/);
  assert.equal(calls.length, 1, "only the unpaid probe was sent");
  assert.equal(limiter.used, 0, "the slot was released");
});

test("the mock signer never produces anything but the fixed constant", async () => {
  const signer = createMockSigner(() => undefined);
  assert.equal(await signer.signTypedData({ primaryType: "X", domain: {}, message: {} }), MOCK_SIGNATURE);
  await assert.rejects(signer.signMessage(), /unexpected/);
  await assert.rejects(signer.signTransaction(), /unexpected/);
});
