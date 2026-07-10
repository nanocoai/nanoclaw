import { describe, expect, it } from 'vitest';

import { redactProgressText as redactRunner } from '../container/agent-runner/src/progress-types.js';
import { redactProgressText as redactHost } from './progress-display.js';

const CANARIES: Array<[string, string, string]> = [
  ['Bearer', 'Authorization: Bearer bearer-canary-123456', 'bearer-canary'],
  ['API key', 'OPENAI_API_KEY=sk-canary-1234567890', 'sk-canary'],
  ['凭据 URL', 'https://user:pass@example.com/path', 'user:pass'],
  ['query token', 'https://example.com?a=1&access_token=query-canary-123', 'query-canary'],
  ['私钥', '-----BEGIN PRIVATE KEY-----\nprivate-canary-body\n-----END PRIVATE KEY-----', 'private-canary-body'],
  ['GitHub token', 'github_pat_canary_1234567890', 'github_pat_canary'],
  ['Slack token', 'xoxb-1234567890', 'xoxb-1234567890'],
  ['AWS access key', 'AKIA123456789012', 'AKIA123456789012'],
];

describe('runner/host progress 脱敏契约', () => {
  it.each(CANARIES)('%s canary 两端一致脱敏', (_name, input, secret) => {
    const runnerOutput = redactRunner(input);
    const hostOutput = redactHost(input);

    expect(runnerOutput).toBe(hostOutput);
    expect(runnerOutput).not.toContain(secret);
    expect(runnerOutput).toContain('[REDACTED');
  });
});
