// A mock payment signer. It performs NO cryptography: no private key is read, derived or used,
// and the "signature" is a fixed constant. It only records what it was asked to sign, so tests
// can verify the exact payment parameters at the signing boundary.
// Plain TypeScript with no imports, so it loads anywhere (child process, loader, unit tests).

export const MOCK_SIGNATURE = `0x${"cd".repeat(65)}` as const;
export const MOCK_ADDRESS = "0x1111111111111111111111111111111111111111" as const;

export interface SignCall {
  primaryType: string;
  domain: { name?: string; version?: string; chainId?: string; verifyingContract?: string };
  message: { from?: string; to?: string; value?: string };
}

const str = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v));

export function createMockSigner(record: (call: SignCall) => void) {
  const refuse = (what: string) => async (): Promise<never> => {
    throw new Error(`mock signer: unexpected ${what}`);
  };
  return {
    address: MOCK_ADDRESS,
    type: "local" as const,
    source: "mock" as const,
    publicKey: "0x" as const,
    signTypedData: async (p: {
      primaryType?: unknown;
      domain?: Record<string, unknown>;
      message?: Record<string, unknown>;
    }): Promise<typeof MOCK_SIGNATURE> => {
      record({
        primaryType: String(p.primaryType),
        domain: {
          name: str(p.domain?.name),
          version: str(p.domain?.version),
          chainId: str(p.domain?.chainId),
          verifyingContract: str(p.domain?.verifyingContract),
        },
        message: { from: str(p.message?.from), to: str(p.message?.to), value: str(p.message?.value) },
      });
      return MOCK_SIGNATURE;
    },
    signMessage: refuse("signMessage"),
    signTransaction: refuse("signTransaction"),
    signAuthorization: refuse("signAuthorization"),
  };
}
