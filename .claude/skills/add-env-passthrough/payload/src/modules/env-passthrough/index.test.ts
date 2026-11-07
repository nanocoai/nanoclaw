import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectContributedEnv } from '../../container-env-contributors.js';
import type { ContainerConfig } from '../../container-config.js';
import './index.js';

const ctx = { agentGroupId: 'agent-1', sessionId: 'session-1', containerConfig: {} as ContainerConfig };

let dir: string;

function writeEnv(content: string): void {
  fs.writeFileSync(path.join(dir, '.env'), content);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-passthrough-'));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('env-passthrough module wiring', () => {
  it('is registered with the container env seam by importing the module', () => {
    writeEnv('CONTAINER_ENV_PASSTHROUGH=LOG_FORMAT\nLOG_FORMAT=json\n');
    expect(collectContributedEnv(ctx)).toEqual({ LOG_FORMAT: 'json' });
  });

  it('forwards nothing when the list is unset', () => {
    writeEnv('LOG_FORMAT=json\n');
    expect(collectContributedEnv(ctx)).toEqual({});
  });

  it('forwards nothing when there is no .env file', () => {
    expect(collectContributedEnv(ctx)).toEqual({});
  });

  it('never forwards a credential, even when the operator lists it', () => {
    writeEnv(
      [
        'CONTAINER_ENV_PASSTHROUGH=LOG_FORMAT,SERVICE_TOKEN,PLAIN_NAME',
        'LOG_FORMAT=json',
        'SERVICE_TOKEN=not-a-real-token',
        'PLAIN_NAME=sk-' + 'a'.repeat(40),
      ].join('\n'),
    );
    expect(collectContributedEnv(ctx)).toEqual({ LOG_FORMAT: 'json' });
  });

  it('picks up an .env change on the next spawn without a restart', () => {
    writeEnv('CONTAINER_ENV_PASSTHROUGH=A\nA=1\n');
    expect(collectContributedEnv(ctx)).toEqual({ A: '1' });
    writeEnv('CONTAINER_ENV_PASSTHROUGH=A\nA=2\n');
    expect(collectContributedEnv(ctx)).toEqual({ A: '2' });
  });

  it('is imported by the modules barrel', () => {
    const barrel = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
    expect(barrel).toContain("import './env-passthrough/index.js';");
  });
});
