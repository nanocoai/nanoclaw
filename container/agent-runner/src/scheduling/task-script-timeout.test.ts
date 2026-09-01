/**
 * Guard: the pre-task script timeout honors TASK_SCRIPT_TIMEOUT_MS.
 *
 * SCRIPT_TIMEOUT_MS is baked into the module at load time from process.env,
 * and other test files in this tree import task-script.ts without the env
 * var set — so the override is exercised in a child bun process where the
 * env var is set before the module ever loads.
 *
 * Red conditions: if the timeout is a hard-coded constant again (env override
 * ignored), the child's 3s script completes despite the 500ms override and
 * the child exits non-zero.
 */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const MODULE = path.join(import.meta.dir, 'task-script.ts');

// Sleeps past the 500ms override, then prints a valid wakeAgent result. If
// the override is honored the run is killed early and resolves null; if not,
// the script completes and returns a non-null result.
const SCRIPT = `sleep 3; echo '{"wakeAgent": true}'`;

describe('task-script timeout knob', () => {
  test(
    'TASK_SCRIPT_TIMEOUT_MS overrides the script timeout',
    () => {
      const snippet = `
        (async () => {
          const { runScript } = await import(${JSON.stringify(MODULE)});
          const t0 = Date.now();
          const res = await runScript(${JSON.stringify(SCRIPT)}, 'timeout-guard-${process.pid}');
          const elapsed = Date.now() - t0;
          if (res !== null) {
            console.error('script survived a 500ms timeout (result ' + JSON.stringify(res) + ') - override not honored');
            process.exit(1);
          }
          if (elapsed > 2500) {
            console.error('script only died after ' + elapsed + 'ms - override not honored');
            process.exit(1);
          }
          process.exit(0);
        })().catch((err) => {
          console.error(err);
          process.exit(1);
        });
      `;
      const proc = Bun.spawnSync(['bun', '-e', snippet], {
        env: { ...process.env, TASK_SCRIPT_TIMEOUT_MS: '500' },
      });
      if (proc.exitCode !== 0) {
        console.error(new TextDecoder().decode(proc.stderr));
      }
      expect(proc.exitCode).toBe(0);
    },
    15_000,
  );

  test('default timeout is 10 minutes when the env var is unset', () => {
    // The 10-minute default is not practical to exercise in a test run, so
    // assert the fallback expression structurally.
    const src = fs.readFileSync(MODULE, 'utf8');
    expect(src).toMatch(/Number\(process\.env\.TASK_SCRIPT_TIMEOUT_MS \|\| 600_000\)/);
  });
});
