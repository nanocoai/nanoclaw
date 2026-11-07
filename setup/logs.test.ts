import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, expect, it } from 'vitest';

import * as setupLog from './logs.js';

const token = ['ghp', 'T3stT0kenQ9wErTy5uIoP1aSdFgH2jKlZx8C'].join('_');
let root: string;
let prevCwd: string;

beforeEach(() => {
  prevCwd = process.cwd();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-logs-'));
  process.chdir(root);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(root, { recursive: true, force: true });
});

it('keeps secrets out of the progression log', () => {
  setupLog.header({ invocation: `setup --token ${token}` });
  setupLog.step('auth', 'failed', 12, { ERROR: `401 for Authorization: Bearer ${token}` });
  setupLog.userInput('slack_bot_token', 'opaqueTESTVALUE');
  setupLog.userInput('display_name', 'Sam');
  setupLog.abort('auth', `GITHUB_TOKEN=${token}`);

  const log = fs.readFileSync(setupLog.progressLogPath, 'utf8');
  expect(log).not.toContain(token);
  expect(log).not.toContain('opaqueTESTVALUE');
  expect(log).toContain('user-input → slack_bot_token');
  expect(log).toContain('value: Sam');
  expect(log).toContain('aborted at auth');
});

it('redacts the bootstrap raw log that the shell bootstrap wrote', () => {
  fs.mkdirSync(setupLog.stepsDir, { recursive: true });
  const bootstrap = path.join(setupLog.stepsDir, '01-bootstrap.log');
  fs.writeFileSync(bootstrap, `pnpm install\nnpm ERR! GITHUB_TOKEN=opaqueTESTVALUE ${token}\ndone\n`);
  setupLog.redactBootstrapLog();
  const log = fs.readFileSync(bootstrap, 'utf8');
  expect(log).not.toContain(token);
  expect(log).not.toContain('opaqueTESTVALUE');
  expect(log).toContain('pnpm install\n');
  expect(log).toContain('done\n');
});
