// Runs the REAL server.ts as a child process, talks to it over MCP stdio, and replaces its
// network with the scripted mock API and its wallet with a mock signer (mock-api-preload.ts).
// No cryptographic signing happens anywhere: the key below is a dummy that is never used, and
// the signer returns a fixed constant. Nothing touches a chain or the real NFT Data API.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import type { LogEntry, Scenario } from "./shared.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PRELOAD = pathToFileURL(fileURLToPath(new URL("./mock-api-preload.ts", import.meta.url))).href;

export type Protocol = "x402" | "mpp";

export interface RunOptions {
  protocolEnv?: string; // value of NFTDATA_PAYMENT_PROTOCOL; omitted = variable unset
  env?: Record<string, string>;
  scenario?: Scenario;
}

function childEnv(opts: RunOptions, logPath: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    // Dummy value with the right shape. It is never used: "viem/accounts" is replaced by a mock
    // signer, and the all-zero scalar is not a valid secp256k1 key, so a real signer would refuse it.
    EVM_PRIVATE_KEY: `0x${"00".repeat(32)}`,
    MOCK_API_SCENARIO: JSON.stringify(opts.scenario ?? {}),
    MOCK_API_LOG: logPath,
    ...opts.env,
  };
  if (opts.protocolEnv !== undefined) env.NFTDATA_PAYMENT_PROTOCOL = opts.protocolEnv;
  return env;
}

const serverArgs = ["--import", "tsx", "--import", PRELOAD, "server.ts"];

export function readLog(logPath: string): LogEntry[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LogEntry);
}

export interface Session {
  client: Client;
  log: () => LogEntry[];
  call: (collection: string) => Promise<{ isError: boolean; text: string }>;
}

export async function withServer(opts: RunOptions, fn: (s: Session) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nftdata-mcp-test-"));
  const logPath = join(dir, "requests.jsonl");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: serverArgs,
    cwd: ROOT,
    env: childEnv(opts, logPath),
    stderr: "ignore",
  });
  const client = new Client({ name: "nftdata-mcp-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    await fn({
      client,
      log: () => readLog(logPath),
      call: async (collection) => {
        const res = (await client.callTool({ name: "get_collection_data", arguments: { collection } })) as {
          isError?: boolean;
          content: { type: string; text: string }[];
        };
        return { isError: res.isError === true, text: res.content.map((c) => c.text).join("\n") };
      },
    });
    // Invariants for every run: no network access beyond the mock, and nothing was ever signed
    // by anything other than the mock signer (the mock API only accepts MOCK_SIGNATURE).
    assert.equal(unexpected(readLog(logPath)).length, 0, "server tried to reach an unexpected URL");
  } finally {
    await client.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

// For configurations that must fail at startup: returns the exit status, stderr, and the mock log.
export function startServerExpectingExit(opts: RunOptions): { status: number | null; stderr: string; log: LogEntry[] } {
  const dir = mkdtempSync(join(tmpdir(), "nftdata-mcp-test-"));
  const logPath = join(dir, "requests.jsonl");
  try {
    const r = spawnSync(process.execPath, serverArgs, {
      cwd: ROOT,
      env: childEnv(opts, logPath),
      encoding: "utf8",
      input: "",
      timeout: 30_000,
    });
    return { status: r.status, stderr: r.stderr ?? "", log: readLog(logPath) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Convenience views over a request log.
export const requests = (log: LogEntry[]) => log.filter((e) => e.kind === "request");
export const credentialed = (log: LogEntry[]) => requests(log).filter((e) => e.credential !== "none");
export const executed = (log: LogEntry[]) => requests(log).filter((e) => e.executed);
export const signs = (log: LogEntry[]) => log.filter((e) => e.kind === "sign");
export const unexpected = (log: LogEntry[]) => log.filter((e) => e.kind === "unexpected-url");
