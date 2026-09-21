/** The container gets no tokens or account metadata; OneCLI owns both. */
export function buildOneCliManagedStub(): Record<string, unknown> {
  return {
    openai: { type: 'oauth', access: 'onecli-managed', refresh: 'onecli-managed', expires: Date.UTC(2100, 0, 1) },
  };
}
