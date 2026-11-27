/**
 * /add-log-rotation leans on two things core owns:
 *  - the service unit writes logs/nanoclaw.log and logs/nanoclaw.error.log in
 *    append mode (setup/service.ts), which is what makes copytruncate safe;
 *  - setup/lib/install-slug.sh names the install's unit, which the timer is named after.
 * Either drifting turns these red.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderSystemdUnit } from '../../../../setup/service.js';
import { getSystemdUnit } from '../../../../src/install-slug.js';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const script = path.join(import.meta.dirname, 'log-rotation.sh');

function findLogrotate(): string | undefined {
  for (const dir of [...(process.env.PATH ?? '').split(':'), '/usr/sbin', '/sbin']) {
    const candidate = path.join(dir, 'logrotate');
    if (dir && fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}
const logrotate = findLogrotate();

describe('/add-log-rotation', () => {
  let tmp: string;
  let root: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-logrotate-')));
    root = path.join(tmp, 'project');
    fs.mkdirSync(path.join(root, 'setup', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(root, 'logs'));
    fs.copyFileSync(
      path.join(repoRoot, 'setup', 'lib', 'install-slug.sh'),
      path.join(root, 'setup', 'lib', 'install-slug.sh'),
    );
    env = {
      ...process.env,
      NANOCLAW_PROJECT_ROOT: root,
      XDG_CONFIG_HOME: path.join(tmp, 'config'),
      XDG_STATE_HOME: path.join(tmp, 'state'),
    };
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const render = (what: string) => execFileSync('bash', [script, what], { env, encoding: 'utf8' });

  it('rotates exactly the files the service unit appends to', () => {
    const unit = renderSystemdUnit(root, '/usr/bin/node', '/home/u', false);
    const appended = [...unit.matchAll(/^Standard(?:Output|Error)=append:(.+)$/gm)].map((m) => m[1]);
    expect(appended).toEqual([`${root}/logs/nanoclaw.log`, `${root}/logs/nanoclaw.error.log`]);

    const conf = render('render-conf');
    const rotated = [...conf.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(rotated).toEqual(appended);
    expect(conf).toMatch(/^\s+copytruncate$/m);
  });

  it("names the timer after the install's service unit", () => {
    const name = `${getSystemdUnit(root)}-logrotate`;
    expect(render('render-service')).toContain(
      `--state "${tmp}/state/nanoclaw/${name}.status" "${tmp}/config/nanoclaw/${name}.conf"`,
    );
    expect(render('render-timer')).toMatch(/^OnCalendar=hourly$/m);
  });

  it.skipIf(!logrotate)('keeps an append-mode writer going after copytruncate', () => {
    const log = path.join(root, 'logs', 'nanoclaw.log');
    const fd = fs.openSync(log, 'a');
    try {
      fs.writeSync(fd, 'x'.repeat(4096) + '\n');
      const conf = path.join(tmp, 'rotate.conf');
      fs.writeFileSync(conf, render('render-conf'));
      execFileSync(logrotate!, ['--force', '--state', path.join(tmp, 'state.status'), conf]);
      fs.writeSync(fd, 'after rotation\n');
    } finally {
      fs.closeSync(fd);
    }
    // Append mode: no NUL-filled gap where the old content was.
    expect(fs.readFileSync(log, 'utf8')).toBe('after rotation\n');
    const archives = fs.readdirSync(path.join(root, 'logs')).filter((f) => /^nanoclaw\.log-\d{8}-\d{6}\.gz$/.test(f));
    expect(archives).toHaveLength(1);
  });
});
