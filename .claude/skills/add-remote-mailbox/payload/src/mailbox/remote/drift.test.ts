/**
 * Drift guard for the host copy of the agent-side mailbox SQL.
 *
 * `operations.ts` re-implements the runner's SQLite mailbox on the host
 * (better-sqlite3 instead of bun:sqlite) so a remote runner sees exactly what a
 * mounted one would. `operations.test.ts` checks that behaviour; this test
 * notices when upstream changes the runner side the copy was made from.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const FINGERPRINTS: Record<string, string> = {
  'container/agent-runner/src/mailbox/sqlite/operations.ts':
    'ad14ebdc4df6b330137cf3c3082bbf2a734800feaee846a360d2c118546cac76',
  'container/agent-runner/src/mailbox/sqlite/index.ts':
    '478ec73574e462f76713542ca77c9ccbdb64d9f090f3b77095c6a4840a96d707',
  'container/agent-runner/src/mailbox/types.ts': '607c65949660b096a6826347b817eed0b5ed344163136759141d2ded883211c1',
};

describe('runner mailbox SQL drift', () => {
  for (const [file, expected] of Object.entries(FINGERPRINTS)) {
    it(`${file} is the version src/mailbox/remote/operations.ts was reviewed against`, () => {
      const actual = crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(process.cwd(), file)))
        .digest('hex');
      expect(
        actual,
        `upstream changed the runner mailbox SQL (${file}); review src/mailbox/remote/operations.ts, ` +
          `then update the fingerprint in src/mailbox/remote/drift.test.ts to ${actual}`,
      ).toBe(expected);
    });
  }
});
