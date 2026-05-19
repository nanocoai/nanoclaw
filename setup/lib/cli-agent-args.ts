interface BuildCliAgentStepArgsInput {
  displayName: string;
  agentName: string;
  folder?: string;
  agentProvider?: string | null;
  modelProvider?: string;
  authMode?: 'auto' | 'api_key' | 'subscription' | 'oauth' | 'native';
}

export function buildCliAgentStepArgs(input: BuildCliAgentStepArgsInput): string[] {
  const args = ['--display-name', input.displayName, '--agent-name', input.agentName];
  if (input.folder) args.push('--folder', input.folder);
  if (input.agentProvider?.toLowerCase() === 'codex') args.push('--provider', 'codex');
  if (input.modelProvider) args.push('--model-provider', input.modelProvider);
  if (input.authMode) args.push('--auth-mode', input.authMode);
  return args;
}
