import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadTemplateSnapshot } from './snapshot.js';

const ROOT = '/tmp/nanoclaw-template-snapshot-test';

afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function writeTemplate(): void {
  fs.mkdirSync(path.join(ROOT, 'ai.nanoco.nanoclaw', 'context'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'policies'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'packages'), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, 'plugin.json'),
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'snapshot-test',
      version: '1.0.0',
    }),
  );
  fs.writeFileSync(path.join(ROOT, 'ai.nanoco.nanoclaw', 'context', 'instructions.md'), 'Hello\n');
  fs.writeFileSync(path.join(ROOT, 'policies', 'policy.json'), '{"apps":{"connections":[]}}');
  fs.writeFileSync(path.join(ROOT, 'packages', 'apt.txt'), '# base\njq\n\n');
  fs.writeFileSync(path.join(ROOT, 'packages', 'npm.txt'), 'csv-parse\n');
}

describe('loadTemplateSnapshot', () => {
  it('returns raw policy, packages, and a content-sensitive stable digest', () => {
    writeTemplate();
    const first = loadTemplateSnapshot(ROOT);
    const second = loadTemplateSnapshot(ROOT);
    expect(first.templatePolicy).toEqual({ apps: { connections: [] } });
    expect(first.packages).toEqual({ apt: ['jq'], npm: ['csv-parse'] });
    expect(first.digest).toBe(second.digest);

    fs.writeFileSync(path.join(ROOT, 'ai.nanoco.nanoclaw', 'context', 'instructions.md'), 'Changed\n');
    expect(loadTemplateSnapshot(ROOT).digest).not.toBe(first.digest);
  });
});
