// MPP (Machine Payments Protocol) payer for nftdata-mcp, Base mainnet, EVM charge only.
// This is the only file that imports the mppx SDK. It is loaded dynamically by server.ts,
// and only when NFTDATA_PAYMENT_PROTOCOL=mpp, so x402 mode never touches it.
//
// Safety model (verified against mppx 0.17.5):
//  - maxPaymentRetries is 1. mppx's fetch loops `for (retry < maxPaymentRetries)` and signs at
//    most one credential per round; the default of 3 could sign again on a repeated 402.
//  - Challenge selection (orderChallenges) drops everything that is not a native EVM charge.
//    mppx's HTTP transport also turns x402 PAYMENT-REQUIRED headers into synthetic challenges,
//    and evm.charge can sign those, so they must be filtered out explicitly.
//  - onChallenge validates, reserves a spend slot and creates the credential. mppx falls back to
//    signing when onChallenge returns nothing, so every refusal here THROWS.
//  - A fresh mppx instance (and attempt counter) is created per call, so one tool call can never
//    sign twice, even if the SDK's own retry settings changed.
import { Mppx, evm } from "mppx/client";
import { Receipt } from "mppx";
import type { Account } from "viem";
import {
  BASE_MAINNET,
  EXACT_AMOUNT_ATOMIC,
  REFUSAL_PREFIX,
  validateMppChallenge,
  validateTxHash,
  type MppChallengeLike,
  type SpendLimiter,
} from "./lib.js";

const BASE_CHAIN_ID = Number(BASE_MAINNET.split(":")[1]);

const refusal = (reason: string) => new Error(`${REFUSAL_PREFIX}${reason}`);

export interface MppFetchOptions {
  account: Account;
  limiter: SpendLimiter;
  maxRequests: number;
  // @internal Test seam only; server.ts never sets it. Lets tests prove the per-call attempt
  // guard below holds independently of the SDK's own retry loop. Production always uses 1.
  sdkMaxPaymentRetries?: number;
}

export type PayFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createMppFetch(options: MppFetchOptions): PayFetch {
  const { account, limiter, maxRequests, sdkMaxPaymentRetries = 1 } = options;
  // Captured once, like the x402 path captures `fetch` when it wraps it.
  const baseFetch = globalThis.fetch;

  return (input, init) => {
    // Per-call state: at most one credential may be created for this call.
    const state = { attempts: 0 };

    const mppx = Mppx.create({
      polyfill: false,
      fetch: baseFetch,
      maxPaymentRetries: sdkMaxPaymentRetries,
      methods: [
        evm.charge({
          account,
          networks: [BASE_CHAIN_ID],
          currencies: [evm.assets.base.USDC],
          maxAtomicAmount: EXACT_AMOUNT_ATOMIC.toString(),
        }),
      ],
      // Only a fully valid native offer may be signed. Returning at most one candidate also
      // means the SDK can never choose between several offers on its own.
      orderChallenges: (candidates) => {
        const valid = candidates.filter((c) => validateMppChallenge(c.challenge as MppChallengeLike) === null);
        if (valid.length === 0) {
          const native = candidates.find((c) => !c.challenge.id.startsWith("x402:"));
          const reason = native
            ? validateMppChallenge(native.challenge as MppChallengeLike)
            : "no acceptable MPP offer";
          throw refusal(reason ?? "no acceptable MPP offer");
        }
        return valid.slice(0, 1);
      },
      onChallenge: async (challenge, { createCredential }) => {
        // Re-validate the challenge that is actually about to be signed.
        const reason = validateMppChallenge(challenge as MppChallengeLike);
        if (reason) throw refusal(reason);
        if (state.attempts >= 1) throw refusal("only one payment attempt is allowed per request");
        if (!limiter.tryReserve()) {
          throw refusal(`paid request limit (${maxRequests}) for this session reached`);
        }
        state.attempts++;
        try {
          return await createCredential();
        } catch (e) {
          // Signing failed after the slot was reserved; release it so the counter stays accurate.
          limiter.release();
          throw e;
        }
      },
    });

    return mppx.fetch(input, init);
  };
}

// Returns the settlement transaction hash from a Payment-Receipt header, or null when the header
// is missing, malformed or does not hold a valid transaction hash.
export function readMppTxHash(header: string | null): string | null {
  if (!header) return null;
  try {
    return validateTxHash(Receipt.deserialize(header).reference);
  } catch {
    return null;
  }
}
