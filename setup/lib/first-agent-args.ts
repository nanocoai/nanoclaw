interface BuildFirstAgentStepArgsInput {
  channel: string;
  userId: string;
  platformId: string;
  displayName: string;
  agentName: string;
  role: string;
  agentProvider?: string | null;
  modelProvider?: string;
  authMode?: 'auto' | 'api_key' | 'subscription' | 'oauth' | 'native';
}

export type FirstAgentProviderOptions = Pick<
  BuildFirstAgentStepArgsInput,
  'agentProvider' | 'modelProvider' | 'authMode'
>;

export function buildFirstAgentStepArgs(input: BuildFirstAgentStepArgsInput): string[] {
  const args = [
    'exec', 'tsx', 'scripts/init-first-agent.ts',
    '--channel', input.channel,
    '--user-id', input.userId,
    '--platform-id', input.platformId,
    '--display-name', input.displayName,
    '--agent-name', input.agentName,
    '--role', input.role,
  ];
  if (input.agentProvider?.toLowerCase() === 'codex') args.push('--provider', 'codex');
  if (input.modelProvider) args.push('--model-provider', input.modelProvider);
  if (input.authMode) args.push('--auth-mode', input.authMode);
  return args;
}
