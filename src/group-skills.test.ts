import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-group-skills-test';
const DATA_DIR = path.join(TEST_ROOT, 'data');

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-group-skills-test/data',
}));

import { materializeTemplateSkills } from './group-skills.js';

function templateSkill(groupId: string, name: string, file: string, content: string): void {
  const dir = path.join(DATA_DIR, 'v2-sessions', groupId, '.claude-shared', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('materializeTemplateSkills', () => {
  it('copies real template-skill dirs into the provider skills dir', () => {
    templateSkill('g1', 'widget', 'SKILL.md', 'body');
    const dest = path.join(TEST_ROOT, 'grp1', '.agents', 'skills');

    materializeTemplateSkills('g1', dest);

    expect(fs.readFileSync(path.join(dest, 'widget', 'SKILL.md'), 'utf-8')).toBe('body');
    expect(fs.lstatSync(path.join(dest, 'widget')).isSymbolicLink()).toBe(false);
  });

  it('is a no-op when the group has no template skills', () => {
    const dest = path.join(TEST_ROOT, 'grp2', '.agents', 'skills');
    materializeTemplateSkills('g2', dest);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('overwrites its own skill dirs but leaves other destination entries intact', () => {
    templateSkill('g3', 'widget', 'SKILL.md', 'new');
    const dest = path.join(TEST_ROOT, 'grp3', '.agents', 'skills');
    fs.mkdirSync(dest, { recursive: true });
    // Stale copy of the same skill (should be refreshed) + a coexisting
    // shared-skill symlink (must NOT be touched — it is provider-owned).
    fs.mkdirSync(path.join(dest, 'widget'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'widget', 'SKILL.md'), 'old');
    fs.symlinkSync('/app/skills/shared', path.join(dest, 'shared'));

    materializeTemplateSkills('g3', dest);

    expect(fs.readFileSync(path.join(dest, 'widget', 'SKILL.md'), 'utf-8')).toBe('new');
    expect(fs.lstatSync(path.join(dest, 'shared')).isSymbolicLink()).toBe(true);
  });

  it('skips dangling shared-skill symlinks in the SOURCE store instead of throwing', () => {
    // container-runner's syncSkillSymlinks fills this same store with links to
    // container paths, which never resolve on the host. Following one used to
    // throw ENOENT out of the caller's container contribution and abort every
    // spawn for the group — a total outage, not a missing skill.
    const srcDir = path.join(DATA_DIR, 'v2-sessions', 'g5', '.claude-shared', 'skills');
    templateSkill('g5', 'widget', 'SKILL.md', 'body');
    fs.symlinkSync('/app/skills/agent-browser', path.join(srcDir, 'agent-browser'));
    const dest = path.join(TEST_ROOT, 'grp5', '.agents', 'skills');

    expect(() => materializeTemplateSkills('g5', dest)).not.toThrow();

    // The real template skill still crosses over; the dangling link does not.
    expect(fs.readFileSync(path.join(dest, 'widget', 'SKILL.md'), 'utf-8')).toBe('body');
    expect(fs.existsSync(path.join(dest, 'agent-browser'))).toBe(false);
  });

  it('skips a symlinked directory in the source (template skills are real dirs)', () => {
    // Resolvable, but still not a template skill — mirroring it would copy
    // content the provider is expected to get from its own shared-skill links.
    const realElsewhere = path.join(TEST_ROOT, 'elsewhere', 'linked');
    fs.mkdirSync(realElsewhere, { recursive: true });
    fs.writeFileSync(path.join(realElsewhere, 'SKILL.md'), 'linked');
    templateSkill('g6', 'widget', 'SKILL.md', 'body');
    const srcDir = path.join(DATA_DIR, 'v2-sessions', 'g6', '.claude-shared', 'skills');
    fs.symlinkSync(realElsewhere, path.join(srcDir, 'linked'));
    const dest = path.join(TEST_ROOT, 'grp6', '.agents', 'skills');

    materializeTemplateSkills('g6', dest);

    expect(fs.existsSync(path.join(dest, 'widget'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'linked'))).toBe(false);
  });

  it('does not destroy skills when dest equals the source (Claude reads source directly)', () => {
    templateSkill('g4', 'widget', 'SKILL.md', 'body');
    const src = path.join(DATA_DIR, 'v2-sessions', 'g4', '.claude-shared', 'skills');

    materializeTemplateSkills('g4', src);

    expect(fs.existsSync(path.join(src, 'widget', 'SKILL.md'))).toBe(true);
  });
});
