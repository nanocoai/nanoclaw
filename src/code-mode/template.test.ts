import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../config.js', async (original) => ({
  ...(await original<typeof import('../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-code-template/data',
  GROUPS_DIR: '/tmp/nanoclaw-code-template/groups',
  TEMPLATES_DIR: '/tmp/nanoclaw-code-template/templates',
}));

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { getContainerConfig } from '../db/container-configs.js';
import { createAgentFromTemplate } from '../templates/create-agent.js';
import { parseTemplate } from '../templates/parse.js';
import { NANOCLAW_EXTENSION_NS } from '../templates/extension.js';
import './index.js';

const root = '/tmp/nanoclaw-code-template';
const dir = path.join(root, 'templates/dev-sandbox');
beforeEach(async () => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'dev-sandbox',
      version: '1.0.0',
      description: 'Coding workspace',
      extensions: { [NANOCLAW_EXTENSION_NS]: { agentName: 'Dev Sandbox', codeMode: true } },
    }),
  );
  await runMigrations(await initTestDb());
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

it('stamps code mode before a templated group has any session', async () => {
  expect(parseTemplate(dir)).toMatchObject({ codeMode: true, report: [] });
  const { group } = await createAgentFromTemplate('dev-sandbox');
  expect((await getContainerConfig(group.id))?.code_mode).toBe(1);
});

it('rejects malformed facts; omission and false keep chat mode', async () => {
  const file = path.join(dir, 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const value of ['true', 1, null]) {
    manifest.extensions[NANOCLAW_EXTENSION_NS].codeMode = value;
    fs.writeFileSync(file, JSON.stringify(manifest));
    await expect(createAgentFromTemplate('dev-sandbox')).rejects.toThrow('codeMode must be a boolean');
  }
  for (const value of [undefined, false]) {
    manifest.extensions[NANOCLAW_EXTENSION_NS].codeMode = value;
    fs.writeFileSync(file, JSON.stringify(manifest));
    const { group } = await createAgentFromTemplate('dev-sandbox');
    expect((await getContainerConfig(group.id))?.code_mode).toBe(0);
  }
});
