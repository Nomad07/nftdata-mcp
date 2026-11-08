// Node module-resolution hook (registered by mock-api-preload.ts). It redirects the server's own
// import of "viem/accounts" to the mock signer, so no real key handling or signing can happen.
// Only imports made by server.ts are redirected; SDK internals are left untouched.
let mockUrl;

export async function initialize(data) {
  mockUrl = data.mockUrl;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "viem/accounts" && context.parentURL?.endsWith("/server.ts")) {
    return { url: mockUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
