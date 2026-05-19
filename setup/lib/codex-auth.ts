export type CodexAuthMode = 'subscription' | 'api' | 'skip';

export interface OnecliSecretSummary {
  id: string;
  name: string;
  type: string;
  hostPattern: string | null;
}

export function parseCodexAuthMode(value: string | null | undefined): CodexAuthMode | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'subscription' || normalized === 'api' || normalized === 'skip') return normalized;
  return null;
}

export function hasOpenAiSecret(secrets: OnecliSecretSummary[]): boolean {
  return secrets.some((s) => s.type === 'openai' || s.hostPattern === 'api.openai.com');
}

export function buildOpenAiSecretCreateArgs(token: string): string[] {
  return [
    'secrets',
    'create',
    '--name',
    'OpenAI',
    '--type',
    'openai',
    '--value',
    token,
    '--host-pattern',
    'api.openai.com',
  ];
}
