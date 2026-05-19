export type AgentProviderChoice = 'claude' | 'codex' | 'both';

export function parseAgentProviderChoice(value: string | undefined | null): AgentProviderChoice | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'claude' || normalized === 'codex' || normalized === 'both') return normalized;
  return null;
}

export function defaultRuntimeProvider(choice: AgentProviderChoice): 'claude' | 'codex' {
  return choice === 'codex' ? 'codex' : 'claude';
}

export function includesCodex(choice: AgentProviderChoice): boolean {
  return choice === 'codex' || choice === 'both';
}
