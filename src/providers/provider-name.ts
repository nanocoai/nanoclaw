/**
 * The one rule for which provider an agent group runs on: the session's
 * pinned provider, else the group's container config, else Claude. Spawn
 * resolves through this, and so does every host command that must validate
 * against the group's actual provider (e.g. `--speed`).
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  return (sessionProvider || containerConfigProvider || 'claude').toLowerCase();
}
