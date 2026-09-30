import { describe, expect, it } from 'vitest';

import { AGENT_RUNNER_PRELOAD_SEAM, agentRunnerLaunchArgs } from './container-runner.js';

describe('agent runner preload seam', () => {
  it('keeps the historical command unless the preload is one absolute container path', () => {
    expect(AGENT_RUNNER_PRELOAD_SEAM).toBe(1);
    expect(agentRunnerLaunchArgs(undefined)).toEqual(['exec bun run /app/src/index.ts']);
    expect(agentRunnerLaunchArgs('')).toEqual(['exec bun run /app/src/index.ts']);
    expect(agentRunnerLaunchArgs('/opt/provider/preload.mjs')).toEqual([
      'exec bun run --preload /opt/provider/preload.mjs /app/src/index.ts',
    ]);
    expect(() => agentRunnerLaunchArgs('/tmp/has space.ts')).toThrow(/absolute container path/);
    expect(() => agentRunnerLaunchArgs('/opt/../preload.mjs')).toThrow(/absolute container path/);
  });
});
