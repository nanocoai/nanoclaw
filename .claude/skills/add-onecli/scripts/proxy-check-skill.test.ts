import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { applySkill, fullyApplied, type ApplyEvent } from '../../../../scripts/skill-apply.js';

const SKILL_DIR = path.resolve('.claude/skills/add-onecli');
const HINT = 'The remote OneCLI gateway tells agents to use the proxy host.docker.internal:10255, their own machine.';

// The setup wizard hides a successful step's output, so the warning reaches the
// operator only as an nc:operator block. Prove it through the real engine.
async function apply(checkOutput: string): Promise<{ ok: boolean; operator: string[] }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'add-onecli-apply-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"scratch"}\n');
    fs.writeFileSync(path.join(root, '.env'), '');
    fs.mkdirSync(path.join(root, 'src/gateway-providers'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/gateway-providers/installed.ts'), '');
    const events: ApplyEvent[] = [];
    const res = await applySkill(SKILL_DIR, root, {
      exec: (cmd) => (cmd.includes('check-proxy.ts') ? checkOutput : ''),
      onEvent: (e) => {
        events.push(e);
      },
    });
    const operator = events.flatMap((e) => (e.type === 'operator' ? [e.text] : []));
    return { ok: fullyApplied(res), operator };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('add-onecli: the agent proxy check', () => {
  it('shows the hint to the operator when the check warns, and still installs', async () => {
    const { ok, operator } = await apply(JSON.stringify({ status: 'warn', hint: HINT }));
    expect(ok).toBe(true);
    expect(operator).toEqual([HINT]);
  });

  it('shows nothing when the check passes or is skipped', async () => {
    for (const out of [{ status: 'ok' }, { status: 'skipped', reason: 'status 401' }]) {
      const { ok, operator } = await apply(JSON.stringify(out));
      expect(ok).toBe(true);
      expect(operator).toEqual([]);
    }
  });
});
