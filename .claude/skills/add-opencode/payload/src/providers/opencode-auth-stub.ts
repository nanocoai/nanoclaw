/**
 * The non-secret value the runtime presents in place of every OpenCode
 * credential. The selected gateway replaces or overrides it at the network
 * boundary; no token or account id ever reaches a container.
 *
 * Must equal OPENCODE_CREDENTIAL_PLACEHOLDER in
 * container/agent-runner/src/providers/opencode-auth.ts. The host and
 * container trees cannot share a module; scripts/opencode-vault.test.ts
 * asserts the two agree.
 */
export const OPENCODE_CREDENTIAL_PLACEHOLDER = 'nc-opencode-token-v1';

/** Sign-in-free auth state for model-catalog runs; same shape the runtime writes. */
export function buildGatewayManagedStub(): Record<string, unknown> {
  return {
    openai: {
      type: 'oauth',
      access: OPENCODE_CREDENTIAL_PLACEHOLDER,
      refresh: OPENCODE_CREDENTIAL_PLACEHOLDER,
      accountId: OPENCODE_CREDENTIAL_PLACEHOLDER,
      expires: Date.UTC(2100, 0, 1),
    },
  };
}
