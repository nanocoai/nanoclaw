import { describe, expect, it } from 'vitest';

import { buildFirstAgentStepArgs } from './first-agent-args.js';

describe('buildFirstAgentStepArgs', () => {
  it('passes codex provider config to channel-created agents', () => {
    expect(
      buildFirstAgentStepArgs({
        channel: 'telegram',
        userId: 'telegram:123',
        platformId: 'telegram:123',
        displayName: 'Chip',
        agentName: 'Nano',
        role: 'owner',
        agentProvider: 'codex',
        modelProvider: 'openai',
        authMode: 'api_key',
      }),
    ).toEqual([
      'exec', 'tsx', 'scripts/init-first-agent.ts',
      '--channel', 'telegram',
      '--user-id', 'telegram:123',
      '--platform-id', 'telegram:123',
      '--display-name', 'Chip',
      '--agent-name', 'Nano',
      '--role', 'owner',
      '--provider', 'codex',
      '--model-provider', 'openai',
      '--auth-mode', 'api_key',
    ]);
  });

  it('leaves provider unset for the default Claude runtime', () => {
    expect(
      buildFirstAgentStepArgs({
        channel: 'discord',
        userId: 'discord:1',
        platformId: 'discord:@me:2',
        displayName: 'Chip',
        agentName: 'Nano',
        role: 'owner',
        agentProvider: 'claude',
      }),
    ).toEqual([
      'exec', 'tsx', 'scripts/init-first-agent.ts',
      '--channel', 'discord',
      '--user-id', 'discord:1',
      '--platform-id', 'discord:@me:2',
      '--display-name', 'Chip',
      '--agent-name', 'Nano',
      '--role', 'owner',
    ]);
  });
});
