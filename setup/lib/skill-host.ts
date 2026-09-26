/**
 * The headless half of the skill driver: how a SKILL.md's commands run on the
 * host and which remote carries the registry branches. Kept free of prompt and
 * terminal-UI packages so the /update-nanoclaw controller can load it from a
 * `git archive` extract that has no node_modules (see
 * scripts/update/controller-archive.test.ts).
 */
import { execSync, spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ExecContext } from '../../scripts/skill-apply.js';

/**
 * Host exec for the engine's run directives. Returns stdout so a
 * `run capture:<var>` can bind it. Puts the project's `bin/` on PATH so a bare
 * `ncl …` in a wire directive resolves to `bin/ncl` even when it isn't
 * symlinked onto the operator's PATH.
 *
 * Async (spawn, not execSync) so the step spinner keeps animating: a sync exec
 * blocks the event loop for the whole command and freezes every ticker in the
 * process. A failure rejects with the FIRST line as the actionable summary —
 * `exit <code>: <first stderr line>` — and the full stderr kept below, so
 * one-line consumers (run-channel-skill's bounce warn) stay readable while the
 * agentTask reason an agent fixes from still carries everything.
 *
 * Non-step effects are captured-output steps — the spinner is the only UI, and
 * stderr is piped, never echoed (a chatty tool's warnings don't belong on the
 * wizard screen). When `rawLog` is given, every command's stdout+stderr is
 * appended there (level 3, like runner.ts's per-step raw logs) so the silenced
 * noise stays inspectable.
 */
export function hostExec(
  projectRoot: string,
  rawLog?: string,
): (cmd: string, context?: ExecContext) => Promise<string> {
  const tee = (cmd: string, stdout: string, stderr: string): void => {
    if (!rawLog) return;
    const body = [stdout, stderr].filter(Boolean).join('');
    appendFileSync(rawLog, `$ ${cmd}\n${body}${body && !body.endsWith('\n') ? '\n' : ''}\n`);
  };
  return (cmd, context) =>
    new Promise((resolve, reject) => {
      const child = spawn('bash', ['-c', cmd], {
        cwd: projectRoot,
        env: { ...process.env, PATH: `${join(projectRoot, 'bin')}:${process.env.PATH ?? ''}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (c: Buffer) => {
        out += c.toString('utf8');
      });
      child.stderr.on('data', (c: Buffer) => {
        err += c.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (code) => {
        const redact = context?.redact ?? ((text: string) => text);
        tee(redact(cmd), redact(out), redact(err));
        if (code === 0) return resolve(out);
        const stderr = redact(err).trim();
        const head =
          stderr
            .split('\n')
            .map((l) => l.trim())
            .find(Boolean) ?? 'command failed';
        reject(new Error(`exit ${code ?? '?'}: ${head}${stderr ? `\n${stderr}` : ''}`));
      });
    });
}

/** Fork-aware registry-branch remote (same resolver setup/channels/slack.ts uses). */
export function channelsRemote(projectRoot: string): () => string {
  return () =>
    execSync('source setup/lib/channels-remote.sh; resolve_channels_remote', {
      cwd: projectRoot,
      shell: '/bin/bash',
      encoding: 'utf8',
    }).trim();
}
