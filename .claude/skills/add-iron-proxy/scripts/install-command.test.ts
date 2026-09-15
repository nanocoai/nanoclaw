import { describe, expect, it } from 'vitest';
import { installCommand, installStep } from './install-command.js';

const node = (source: string) => [process.execPath, ['-e', source]] as const;

describe('Iron installer progress and process bounds', () => {
  it('reports progress before a slow command completes and never prints its output', async () => {
    const lines: string[] = [];
    let finished = false;
    const [command, args] = node(
      'console.log("token=must-not-leak"); console.error("password=must-not-leak"); setTimeout(() => {}, 180)',
    );
    const pending = installCommand(command, [...args], {
      label: 'Download pinned source',
      timeoutMs: 2000,
      heartbeatMs: 20,
      report: (line) => {
        lines.push(line);
      },
    }).then(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(finished).toBe(false);
    expect(lines.some((line) => line.includes('still running'))).toBe(true);
    await pending;
    expect(lines.at(-1)).toContain('done');
    expect(lines.join('\n')).not.toContain('must-not-leak');
  });

  it('closes stdin and disables interactive Git credential prompts', async () => {
    const [command, args] = node(`process.stdin.resume(); process.stdin.on('end', () => {
      if (process.env.GIT_TERMINAL_PROMPT !== '0' || process.env.GCM_INTERACTIVE !== 'Never' || process.env.GIT_ASKPASS !== '/usr/bin/false') process.exit(2);
      console.log('noninteractive');
    });`);
    expect(
      await installCommand(command, [...args], {
        label: 'Git fetch',
        timeoutMs: 2000,
        capture: true,
        report: () => {},
      }),
    ).toBe('noninteractive');
  });

  it('fails a denied fetch without exposing credential-bearing stderr', async () => {
    const lines: string[] = [];
    const [command, args] = node(
      'console.error("https://secret-token@github.com/private/repo password=secret"); process.exit(128)',
    );
    await expect(
      installCommand(command, [...args], {
        label: 'Fetch pinned source',
        timeoutMs: 2000,
        failureHint: 'Verify source access from this machine.',
        report: (line) => lines.push(line),
      }),
    ).rejects.toThrow('Verify source access from this machine');
    expect(lines.join('\n')).not.toContain('secret');
    expect(lines.join('\n')).toContain('exit 128');
  });

  it('kills an unresponsive child and rejects at the deadline instead of leaving a timer running', async () => {
    const [command, args] = node('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)');
    const started = Date.now();
    await expect(
      installCommand(command, [...args], {
        label: 'Build image',
        timeoutMs: 100,
        killGraceMs: 40,
        heartbeatMs: 20,
        report: () => {},
      }),
    ).rejects.toThrow('timed out');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('also kills a descendant that keeps inherited output pipes open', async () => {
    const [command, args] = node(`require('node:child_process').spawn(process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], {stdio: 'inherit'});
      setInterval(() => {}, 1000);`);
    const start = Date.now();
    await expect(
      installCommand(command, [...args], {
        label: 'Fetch with helper',
        timeoutMs: 150,
        killGraceMs: 40,
        report: () => {},
      }),
    ).rejects.toThrow('timed out');
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('emits the skill streaming terminal status for success and failure', async () => {
    const lines: string[] = [];
    expect(
      await installStep(
        async () => {},
        (line) => lines.push(line),
      ),
    ).toBe(true);
    expect(lines.join('\n')).toContain('STATUS: success');
    lines.length = 0;
    expect(
      await installStep(
        async () => {
          throw new Error('Source access unavailable');
        },
        (line) => lines.push(line),
      ),
    ).toBe(false);
    expect(lines.join('\n')).toContain('STATUS: failed');
    expect(lines.join('\n')).not.toContain('STATUS: success');
  });
});
