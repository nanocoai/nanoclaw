export interface ResolvedTargetChatJid {
  chatJid: string;
  alias?: string;
}

export type GroupAliasLookup = (alias: string) => string | undefined;

export function normalizeTargetChatJid(target: string): string {
  const trimmed = target.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('oc_')) return `fs:${trimmed}`;
  return trimmed;
}

export function resolveTargetChatJid(
  target: string,
  lookupAlias: GroupAliasLookup,
): ResolvedTargetChatJid {
  const trimmed = target.trim();
  const aliasValue = lookupAlias(trimmed);
  if (aliasValue) {
    return {
      chatJid: normalizeTargetChatJid(aliasValue),
      alias: trimmed,
    };
  }
  return { chatJid: normalizeTargetChatJid(trimmed) };
}
