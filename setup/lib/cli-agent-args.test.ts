import { describe, expect, it } from 'vitest';

import { buildCliAgentStepArgs } from './cli-agent-args.js';

describe('buildCliAgentStepArgs', () => {
  it('sets the scratch CLI agent provider to codex when Codex is selected as the default agent provider', () => {
    expect(
      buildCliAgentStepArgs({
        displayName: 'Chip',
        agentName: 'Terminal Agent',
        folder: '_ping-test',
        agentProvider: 'codex',
      }),
    ).toEqual([
      '--display-name',
      'Chip',
      '--agent-name',
      'Terminal Agent',
      '--folder',
      '_ping-test',
      '--provider',
      'codex',
    ]);
  });

  it('leaves provider unset for the default Claude setup helper', () => {
    expect(
      buildCliAgentStepArgs({
        displayName: 'Chip',
        agentName: 'Terminal Agent',
        folder: '_ping-test',
        agentProvider: 'claude',
      }),
    ).toEqual(['--display-name', 'Chip', '--agent-name', 'Terminal Agent', '--folder', '_ping-test']);
  });

  it('includes Codex OpenAI auth intent when provided', () => {
    expect(
      buildCliAgentStepArgs({
        displayName: 'Chip',
        agentName: 'Terminal Agent',
        agentProvider: 'codex',
        modelProvider: 'openai',
        authMode: 'api_key',
      }),
    ).toEqual([
      '--display-name',
      'Chip',
      '--agent-name',
      'Terminal Agent',
      '--provider',
      'codex',
      '--model-provider',
      'openai',
      '--auth-mode',
      'api_key',
    ]);
  });
});
