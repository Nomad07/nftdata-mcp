// Types and constants shared by the mock API preload (child process) and the tests.
export interface Scenario {
  // Which payment offers the 402 response carries. Default "both" (like production).
  offers?: "both" | "x402" | "mpp";
  // Overrides applied to the terms of every offer.
  terms?: { amount?: string; payTo?: string; asset?: string; chainId?: number };
  // Answer even a correctly paid request with a fresh 402 challenge.
  always402?: boolean;
  // Answer a correctly paid request with this status instead of executing the operation.
  paidStatus?: number;
  // Delay (ms) before answering an unpaid request, to make concurrent calls overlap.
  delayMs?: number;
}

export interface LogEntry {
  // "request": a request the mock API received. "sign": the mock signer was asked to sign.
  // "unexpected-url": the server tried to reach anything but the official endpoint.
  kind: "request" | "sign" | "unexpected-url";
  slug?: string;
  // kind "sign": the typed data the server asked the (mock) signer to sign.
  primaryType?: string;
  domain?: { name?: string; version?: string; chainId?: string; verifyingContract?: string };
  message?: { from?: string; to?: string; value?: string };
  credential?: "none" | "x402" | "mpp" | "both";
  valid?: boolean;
  value?: string;
  to?: string;
  executed?: boolean;
}

export const TX_HASH = `0x${"ab".repeat(32)}`;
