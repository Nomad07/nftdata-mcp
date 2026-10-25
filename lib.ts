// Pure logic for nftdata-mcp. No imports from the x402 SDK so it can be tested offline,
// without network access and without spending anything.

export const OFFICIAL_ENDPOINT = "https://www.nftdata.app/api/get-collection-data";
const ALLOWED_ENDPOINTS = new Set([OFFICIAL_ENDPOINT, "https://nftdata.app/api/get-collection-data"]);

// Base mainnet, USDC (6 decimals). Price is $0.002 = 2000 atomic units.
export const BASE_MAINNET = "eip155:8453";
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const MAX_AMOUNT_ATOMIC = 2000n;

// Official NFT Data payment recipient on Base (lowercase for comparison).
export const OFFICIAL_PAY_TO = "0x344143199642e87320785823c20c2df107d17534";

export const MAX_REQUESTS_CEILING = 1000;
export const DEFAULT_MAX_REQUESTS = 100;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

export interface Config {
  endpoint: string;
  maxRequests: number;
  timeoutMs: number;
}

function parseIntStrict(name: string, raw: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

// NFTDATA_URL is an untrusted override: only the official endpoint is accepted.
export function resolveEndpoint(override: string | undefined): string {
  if (override === undefined || override.trim() === "") return OFFICIAL_ENDPOINT;
  let normalized: string;
  try {
    const u = new URL(override.trim());
    normalized = `${u.protocol}//${u.host}${u.pathname}`;
    if (u.username || u.password || u.search || u.hash) throw new Error("extra URL parts");
  } catch {
    throw new Error("NFTDATA_URL is not an accepted NFT Data endpoint");
  }
  if (!ALLOWED_ENDPOINTS.has(normalized)) {
    throw new Error("NFTDATA_URL is not an accepted NFT Data endpoint");
  }
  return normalized;
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const maxRaw = env.NFTDATA_MAX_REQUESTS;
  const timeoutRaw = env.NFTDATA_TIMEOUT_MS;
  return {
    endpoint: resolveEndpoint(env.NFTDATA_URL),
    maxRequests:
      maxRaw === undefined || maxRaw.trim() === ""
        ? DEFAULT_MAX_REQUESTS
        : parseIntStrict("NFTDATA_MAX_REQUESTS", maxRaw, 1, MAX_REQUESTS_CEILING),
    timeoutMs:
      timeoutRaw === undefined || timeoutRaw.trim() === ""
        ? DEFAULT_TIMEOUT_MS
        : parseIntStrict("NFTDATA_TIMEOUT_MS", timeoutRaw, 1000, 60_000),
  };
}

export function isValidPrivateKey(pk: string | undefined): pk is `0x${string}` {
  return typeof pk === "string" && /^0x[0-9a-fA-F]{64}$/.test(pk);
}

// Trim + lowercase, then validate. Returns null if the slug is not acceptable.
export function normalizeSlug(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (s.length === 0 || s.length > 100) return null;
  return /^[a-z0-9][a-z0-9_-]*$/.test(s) ? s : null;
}

export interface Requirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
}

// Returns a refusal reason, or null if the challenge is acceptable.
export function validateRequirements(req: Requirements): string | null {
  if (req.scheme !== "exact") return "unexpected payment scheme";
  if (req.network !== BASE_MAINNET) return "unexpected payment network";
  if (typeof req.asset !== "string" || req.asset.toLowerCase() !== USDC_BASE.toLowerCase()) {
    return "unexpected payment token";
  }
  if (typeof req.amount !== "string" || !/^\d+$/.test(req.amount)) return "invalid payment amount";
  if (BigInt(req.amount) > MAX_AMOUNT_ATOMIC) return "payment amount above the expected price";
  if (typeof req.payTo !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(req.payTo)) {
    return "invalid payment recipient";
  }
  if (req.payTo.toLowerCase() !== OFFICIAL_PAY_TO) return "unexpected payment recipient";
  return null;
}

// Counts signed payments. Reserve before signing, release if signing fails.
export class SpendLimiter {
  private reserved = 0;
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  tryReserve(): boolean {
    if (this.reserved >= this.max) return false;
    this.reserved++;
    return true;
  }
  release(): void {
    if (this.reserved > 0) this.reserved--;
  }
  get used(): number {
    return this.reserved;
  }
}

export type ToolResult = { isError?: boolean; content: { type: "text"; text: string }[] };

export const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
export const fail = (text: string): ToolResult => ({ isError: true, content: [{ type: "text", text }] });

// Cache (5 min per slug) + reuse of in-flight requests so concurrent identical calls
// produce a single (paid) request. Failures are never cached.
export class CachedFetcher {
  private cache = new Map<string, { at: number; body: string }>();
  private inflight = new Map<string, Promise<ToolResult>>();
  private readonly load: (slug: string) => Promise<ToolResult>;
  private readonly now: () => number;
  constructor(load: (slug: string) => Promise<ToolResult>, now: () => number = Date.now) {
    this.load = load;
    this.now = now;
  }
  async get(slug: string): Promise<ToolResult> {
    const hit = this.cache.get(slug);
    if (hit && this.now() - hit.at < CACHE_TTL_MS) return ok(hit.body);
    if (hit) this.cache.delete(slug);

    const pending = this.inflight.get(slug);
    if (pending) return pending;

    const p = this.load(slug)
      .then((res) => {
        if (!res.isError) {
          if (this.cache.size >= CACHE_MAX_ENTRIES) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) this.cache.delete(oldest);
          }
          this.cache.set(slug, { at: this.now(), body: res.content[0].text });
        }
        return res;
      })
      .finally(() => {
        this.inflight.delete(slug);
      });
    this.inflight.set(slug, p);
    return p;
  }
}

// Marker used so refusals raised by our own payment hook can be told apart from other errors.
export const REFUSAL_PREFIX = "nftdata-mcp policy: ";

export class TimeoutError extends Error {}

export function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new TimeoutError("timeout"));
    }, ms);
  });
  return Promise.race([run(ctrl.signal), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// Maps an HTTP response to a tool result without leaking server or payment details.
export function mapResponse(status: number, body: string, retryAfter: string | null): ToolResult {
  if (status >= 200 && status < 300) {
    try {
      JSON.parse(body);
    } catch {
      return fail("The NFT Data API returned an unreadable response.");
    }
    return ok(body);
  }
  if (status === 400) return fail("Invalid collection slug.");
  if (status === 404) return fail("Collection not found. Check the slug in the OpenSea collection URL.");
  if (status === 429) {
    const secs = retryAfter && /^\d{1,5}$/.test(retryAfter) ? retryAfter : "a few";
    return fail(`Rate limit exceeded. Retry in ${secs} seconds.`);
  }
  if (status === 402) return fail("Payment was not accepted by the NFT Data API.");
  return fail(`The NFT Data API returned an error (HTTP ${status}).`);
}

// Maps a thrown error to a safe message. Never includes err.message of unknown errors.
export function mapError(err: unknown): ToolResult {
  if (err instanceof TimeoutError) {
    return fail(
      "The request timed out. A payment may have been authorized; it was not retried automatically.",
    );
  }
  const msg = err instanceof Error ? err.message : "";
  const i = msg.indexOf(REFUSAL_PREFIX);
  if (i >= 0) {
    const reason = msg.slice(i + REFUSAL_PREFIX.length).split(/[\n.]/)[0].slice(0, 120);
    return fail(`Payment refused by safety policy: ${reason}.`);
  }
  return fail("The request failed.");
}
