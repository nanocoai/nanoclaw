import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('setup channel picker copy', () => {
  it('describes Slack according to the selected setup experience', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'setup/auto.ts'), 'utf-8');

    expect(src).toContain("label: 'Yes, connect Slack'");
    expect(src).toContain("const slackAgentsEnabled = process.env.NANOCLAW_SLACK_AGENTS === '1'");
    expect(src).toContain(
      "hint: slackAgentsEnabled ? 'automatic app setup' : 'Socket Mode — no public URL needed'",
    );
    expect(src).not.toContain('connect Slack (experimental)');
    expect(src).not.toContain("hint: 'needs public URL'");
  });
});
