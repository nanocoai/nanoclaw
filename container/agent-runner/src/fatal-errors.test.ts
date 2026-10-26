import { describe, expect, test } from 'bun:test';
import path from 'path';

import { describeFatal } from './fatal-errors.js';

describe('describeFatal', () => {
  test('prints the stack and every cause', () => {
    const err = new Error('poll loop failed', { cause: new Error('database is locked') });
    const text = describeFatal(err);
    expect(text).toContain('Error: poll loop failed');
    expect(text).toMatch(/at .*fatal-errors\.test\.ts/);
    expect(text).toContain('caused by: Error: database is locked');
  });

  test('lists AggregateError members and stops on a cause cycle', () => {
    expect(describeFatal(new AggregateError([new Error('a')], 'all failed'))).toContain('error[0]: Error: a');
    const a = new Error('a');
    (a as { cause?: unknown }).cause = a;
    expect(() => describeFatal(a)).not.toThrow();
  });

  test('handles non-Error values', () => {
    expect(describeFatal('boom')).toBe('boom');
  });
});

async function runScript(body: string): Promise<{ code: number; stderr: string }> {
  const handlers = path.join(import.meta.dir, 'fatal-errors.ts');
  const proc = Bun.spawn(
    ['bun', '-e', `const m = await import(${JSON.stringify(handlers)}); m.installFatalErrorHandlers(); ${body}`],
    { stderr: 'pipe', stdout: 'pipe' },
  );
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stderr };
}

describe('installFatalErrorHandlers', () => {
  test('an unhandled rejection is logged with its cause and still exits 1', async () => {
    const { code, stderr } = await runScript(
      "Promise.reject(new Error('turn failed', { cause: new Error('socket hang up') }));",
    );
    expect(code).toBe(1);
    expect(stderr).toContain('[agent-runner] Unhandled rejection: Error: turn failed');
    expect(stderr).toContain('caused by: Error: socket hang up');
  });

  test('an uncaught exception is logged and still exits 1', async () => {
    const { code, stderr } = await runScript("setTimeout(() => { throw new Error('timer blew up'); }, 0);");
    expect(code).toBe(1);
    expect(stderr).toContain('[agent-runner] Uncaught exception: Error: timer blew up');
  });
});
