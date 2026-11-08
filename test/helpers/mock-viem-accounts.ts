// Stand-in for "viem/accounts" inside the server child process (see mock-accounts-hooks.mjs).
// privateKeyToAccount never touches the key: it returns a mock signer that logs sign requests.
import { appendFileSync } from "node:fs";
import { createMockSigner } from "./mock-signer.js";

export function privateKeyToAccount(_privateKey: string) {
  return createMockSigner((call) => {
    const logPath = process.env.MOCK_API_LOG;
    if (logPath) appendFileSync(logPath, `${JSON.stringify({ kind: "sign", ...call })}\n`);
  });
}
