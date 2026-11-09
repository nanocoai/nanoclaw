import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('standalone setup mailbox composition', () => {
  it.each(['setup/migrate-v2/sessions.ts', 'setup/migrate-v2/tasks.ts'])(
    '%s loads before validating argv',
    (script) => {
      const result = spawnSync(process.execPath, ['--import', 'tsx', script], {
        cwd: repoRoot,
        encoding: 'utf8',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Usage:');
      expect(result.stderr).not.toContain('SyntaxError');
    },
  );

  it('setup/register.ts loads with the default mailbox composition', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        "const { run } = await import('./setup/register.ts'); const { getAgentMailbox } = await import('./src/mailbox/index.ts'); const { SqliteAgentMailbox } = await import('./src/mailbox/sqlite/index.ts'); console.log(`${typeof run}:${getAgentMailbox() instanceof SqliteAgentMailbox}`);",
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('function:true');
  });
});
