/**
 * The per-group image build runs from DATA_DIR, which lives in the install
 * folder. A folder name with a space must reach docker as one argument.
 * A stub `docker` on PATH records the argv it receives, one argument per line.
 */
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const fixture = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const root = mkdtempSync(join(tmpdir(), 'image-build-'));
  return { root, dataDir: join(root, 'My NanoClaw', 'data') };
});

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: fixture.dataDir,
  CONTAINER_IMAGE: 'nanoclaw-agent:fixture',
  CONTAINER_IMAGE_BASE: 'nanoclaw-agent',
}));
vi.mock('./db/agent-groups.js', () => ({
  getAgentGroup: vi.fn(async (id: string) => ({ id })),
}));
vi.mock('./db/container-configs.js', () => ({
  getContainerConfig: vi.fn(async () => ({ packages_apt: '["curl"]', packages_npm: '[]' })),
  updateContainerConfigScalars: vi.fn(async () => undefined),
}));
vi.mock('./drivers/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./drivers/index.js')>()),
  getSessionDriver: () => ({ capabilities: () => ({ imageBuild: true }) }),
}));
vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { buildAgentGroupImage } from './container-runner.js';

const binDir = path.join(fixture.root, 'bin');
const callsDir = path.join(fixture.root, 'calls');
const originalPath = process.env.PATH;

beforeAll(() => {
  fs.mkdirSync(fixture.dataDir, { recursive: true });
  fs.mkdirSync(binDir);
  fs.mkdirSync(callsDir);
  fs.writeFileSync(
    path.join(binDir, 'docker'),
    `#!/bin/sh\nn=$(ls "${callsDir}" | wc -l | tr -d ' ')\nprintf '%s\\n' "$@" > "${callsDir}/$n"\n` +
      `[ "$1" = image ] && echo sha256:fixture\nexit 0\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

function recordedCalls(): string[][] {
  return fs
    .readdirSync(callsDir)
    .sort((a, b) => Number(a) - Number(b))
    .map((name) => fs.readFileSync(path.join(callsDir, name), 'utf8').replace(/\n$/, '').split('\n'));
}

describe('buildAgentGroupImage', () => {
  it('hands docker the Dockerfile path as one argument when the install folder has a space', async () => {
    await buildAgentGroupImage('ag-1');
    expect(recordedCalls()).toEqual([
      ['image', 'inspect', '--format', '{{.Id}}', 'nanoclaw-agent:fixture'],
      ['build', '-t', 'nanoclaw-agent:ag-1', '-f', path.join(fixture.dataDir, 'Dockerfile.ag-1'), '.'],
    ]);
  });
});
