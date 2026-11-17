import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-group-skills-test';
const DATA_DIR = path.join(TEST_ROOT, 'data');
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-group-skills-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-group-skills-test/groups',
}));

import { materializeTemplateSkills } from './group-skills.js';
import { log } from './log.js';

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

    materializeTemplateSkills('g1', TEST_ROOT, ['grp1', '.agents', 'skills']);

    expect(fs.readFileSync(path.join(dest, 'widget', 'SKILL.md'), 'utf-8')).toBe('body');
    expect(fs.lstatSync(path.join(dest, 'widget')).isSymbolicLink()).toBe(false);
  });

  it('is a no-op when the group has no template skills', () => {
    const dest = path.join(TEST_ROOT, 'grp2', '.agents', 'skills');
    materializeTemplateSkills('g2', TEST_ROOT, ['grp2', '.agents', 'skills']);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('skips dangling symlinks the Claude plane planted (claude→codex switch)', () => {
    // Regression: shared-skill symlinks in the store resolve only inside the
    // container; statSync followed them host-side, threw ENOENT, and bricked
    // every spawn after a provider switch.
    templateSkill('g5', 'real-skill', 'SKILL.md', 'real');
    fs.symlinkSync(
      '/container/only/path/agent-browser',
      path.join(DATA_DIR, 'v2-sessions', 'g5', '.claude-shared', 'skills', 'agent-browser'),
    );
    const dest = path.join(TEST_ROOT, 'grp5', '.agents', 'skills');

    materializeTemplateSkills('g5', TEST_ROOT, ['grp5', '.agents', 'skills']);

    expect(fs.readFileSync(path.join(dest, 'real-skill', 'SKILL.md'), 'utf-8')).toBe('real');
    expect(fs.existsSync(path.join(dest, 'agent-browser'))).toBe(false);
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

    materializeTemplateSkills('g3', TEST_ROOT, ['grp3', '.agents', 'skills']);

    expect(fs.readFileSync(path.join(dest, 'widget', 'SKILL.md'), 'utf-8')).toBe('new');
    expect(fs.lstatSync(path.join(dest, 'shared')).isSymbolicLink()).toBe(true);
  });

  it('does not destroy skills when dest equals the source (Claude reads source directly)', () => {
    templateSkill('g4', 'widget', 'SKILL.md', 'body');
    const src = path.join(DATA_DIR, 'v2-sessions', 'g4', '.claude-shared', 'skills');

    materializeTemplateSkills('g4', DATA_DIR, ['v2-sessions', 'g4', '.claude-shared', 'skills']);

    expect(fs.existsSync(path.join(src, 'widget', 'SKILL.md'))).toBe(true);
  });

  it('preserves an executable skill script and nested dirs', () => {
    const skillDir = path.join(DATA_DIR, 'v2-sessions', 'g7', '.claude-shared', 'skills', 'widget', 'scripts');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'run.sh'), '#!/bin/sh\necho hi\n');
    fs.chmodSync(path.join(skillDir, 'run.sh'), 0o755);

    materializeTemplateSkills('g7', TEST_ROOT, ['grp7', '.agents', 'skills']);

    const copied = path.join(TEST_ROOT, 'grp7', '.agents', 'skills', 'widget', 'scripts', 'run.sh');
    expect(fs.readFileSync(copied, 'utf-8')).toContain('echo hi');
    expect(fs.statSync(copied).mode & 0o111).toBeGreaterThan(0);
  });

  it('refuses a symlinked source skills dir, copying nothing', () => {
    // A host directory the agent would exfiltrate by symlinking the source at it.
    const hostDir = path.join(TEST_ROOT, 'host-src');
    fs.mkdirSync(path.join(hostDir, 'loot'), { recursive: true });
    fs.writeFileSync(path.join(hostDir, 'loot', 'secret.txt'), 'host-secret');
    const srcSkills = path.join(DATA_DIR, 'v2-sessions', 'g8', '.claude-shared', 'skills');
    fs.mkdirSync(path.dirname(srcSkills), { recursive: true });
    fs.symlinkSync(hostDir, srcSkills);
    const dest = path.join(TEST_ROOT, 'grp8', '.agents', 'skills');

    materializeTemplateSkills('g8', TEST_ROOT, ['grp8', '.agents', 'skills']);

    expect(fs.existsSync(path.join(dest, 'loot'))).toBe(false);
  });

  it('refuses a symlinked destination skills dir, deleting and copying nothing through it', () => {
    templateSkill('g6', 'widget', 'SKILL.md', 'body');
    // A host directory the agent would redirect the delete+copy into.
    const hostDir = path.join(TEST_ROOT, 'host-outside');
    fs.mkdirSync(path.join(hostDir, 'widget'), { recursive: true });
    fs.writeFileSync(path.join(hostDir, 'widget', 'keep.txt'), 'host-file');
    // The provider skills dir is a symlink to it, as a compromised agent could leave.
    const skills = path.join(TEST_ROOT, 'grp6', '.agents', 'skills');
    fs.mkdirSync(path.dirname(skills), { recursive: true });
    fs.symlinkSync(hostDir, skills);

    materializeTemplateSkills('g6', TEST_ROOT, ['grp6', '.agents', 'skills']);

    // Nothing was deleted or written through the symlink.
    expect(fs.readFileSync(path.join(hostDir, 'widget', 'keep.txt'), 'utf-8')).toBe('host-file');
    expect(fs.readdirSync(hostDir)).toEqual(['widget']);
  });

  describe('full-path call (no segments)', () => {
    // The legacy provider call shape: one path under the group folder, no
    // anchor root. It must anchor at the group folder and refuse everything
    // the segments form refuses.
    function tree(dir: string): string[] {
      const out: string[] = [];
      const walk = (d: string, prefix: string) => {
        for (const entry of fs.readdirSync(d).sort()) {
          const full = path.join(d, entry);
          const st = fs.lstatSync(full);
          const kind = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file';
          const body = st.isFile() ? `:${fs.readFileSync(full, 'utf-8')}:${(st.mode & 0o777).toString(8)}` : '';
          out.push(`${kind} ${prefix}${entry}${body}`);
          if (st.isDirectory()) walk(full, `${prefix}${entry}/`);
        }
      };
      walk(dir, '');
      return out;
    }

    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      warn.mockRestore();
    });

    it('resolves the legacy shape to the same anchored result as the segments form', () => {
      templateSkill('g10', 'widget', 'SKILL.md', 'body');
      const scripts = path.join(DATA_DIR, 'v2-sessions', 'g10', '.claude-shared', 'skills', 'widget', 'scripts');
      fs.mkdirSync(scripts);
      fs.writeFileSync(path.join(scripts, 'run.sh'), '#!/bin/sh\n');
      fs.chmodSync(path.join(scripts, 'run.sh'), 0o755);
      const groupA = path.join(GROUPS_DIR, 'grp-a');
      const groupB = path.join(GROUPS_DIR, 'grp-b');
      fs.mkdirSync(groupA, { recursive: true });
      fs.mkdirSync(groupB, { recursive: true });

      materializeTemplateSkills('g10', groupA, ['.agents', 'skills']);
      materializeTemplateSkills('g10', path.join(groupB, '.agents', 'skills'));

      expect(tree(groupB)).toEqual(tree(groupA));
      expect(tree(groupB)).toContain('file .agents/skills/widget/SKILL.md:body:644');
      expect(fs.lstatSync(path.join(groupB, '.agents', 'skills', 'widget')).isSymbolicLink()).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });

    it('refuses a symlinked destination skills dir, deleting and copying nothing through it', () => {
      templateSkill('g11', 'widget', 'SKILL.md', 'body');
      const hostDir = path.join(TEST_ROOT, 'host-outside');
      fs.mkdirSync(path.join(hostDir, 'widget'), { recursive: true });
      fs.writeFileSync(path.join(hostDir, 'widget', 'keep.txt'), 'host-file');
      const skills = path.join(GROUPS_DIR, 'grp11', '.agents', 'skills');
      fs.mkdirSync(path.dirname(skills), { recursive: true });
      fs.symlinkSync(hostDir, skills);

      materializeTemplateSkills('g11', skills);

      expect(fs.readFileSync(path.join(hostDir, 'widget', 'keep.txt'), 'utf-8')).toBe('host-file');
      expect(fs.readdirSync(hostDir)).toEqual(['widget']);
      expect(fs.lstatSync(skills).isSymbolicLink()).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('refuses a symlinked intermediate dir below the group folder', () => {
      templateSkill('g12', 'widget', 'SKILL.md', 'body');
      const hostDir = path.join(TEST_ROOT, 'host-outside');
      fs.mkdirSync(path.join(hostDir, 'skills'), { recursive: true });
      const group = path.join(GROUPS_DIR, 'grp12');
      fs.mkdirSync(group, { recursive: true });
      fs.symlinkSync(hostDir, path.join(group, '.agents'));

      materializeTemplateSkills('g12', path.join(group, '.agents', 'skills'));

      expect(fs.readdirSync(path.join(hostDir, 'skills'))).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('refuses a symlinked source skills dir, copying nothing', () => {
      const hostDir = path.join(TEST_ROOT, 'host-src');
      fs.mkdirSync(path.join(hostDir, 'loot'), { recursive: true });
      fs.writeFileSync(path.join(hostDir, 'loot', 'secret.txt'), 'host-secret');
      const srcSkills = path.join(DATA_DIR, 'v2-sessions', 'g13', '.claude-shared', 'skills');
      fs.mkdirSync(path.dirname(srcSkills), { recursive: true });
      fs.symlinkSync(hostDir, srcSkills);
      const dest = path.join(GROUPS_DIR, 'grp13', '.agents', 'skills');

      materializeTemplateSkills('g13', dest);

      expect(fs.existsSync(path.join(dest, 'loot'))).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it.each([
      // Raw strings, so the call really receives the '..' components.
      ['a traversal out of the group folder', (g: string) => `${g}/../../host-outside/.agents/skills`],
      ['a traversal out of the groups dir', () => `${GROUPS_DIR}/../host-outside/.agents/skills`],
      ['a path outside the groups dir', () => path.join(TEST_ROOT, 'host-outside', '.agents', 'skills')],
      ['a sibling dir sharing the groups dir prefix', () => `${GROUPS_DIR}x/grp14/.agents/skills`],
      // These two normalize to a valid group path; the raw string is refused anyway.
      [
        'a traversal into another group',
        (g: string) => `${GROUPS_DIR}/grp-other/../${path.basename(g)}/.agents/skills`,
      ],
      [
        'a relative path that resolves into a group',
        (g: string) => path.relative(process.cwd(), `${g}/.agents/skills`),
      ],
      ['the group folder itself', (g: string) => g],
      ['the groups dir itself', () => GROUPS_DIR],
    ])('refuses %s, creating and copying nothing', (_label, dest) => {
      templateSkill('g14', 'widget', 'SKILL.md', 'body');
      const group = path.join(GROUPS_DIR, 'grp14');
      fs.mkdirSync(group, { recursive: true });
      fs.mkdirSync(path.join(TEST_ROOT, 'host-outside'));
      const before = [...tree(TEST_ROOT)];

      materializeTemplateSkills('g14', dest(group));

      expect(tree(TEST_ROOT)).toEqual(before);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][1]).toMatchObject({ agentGroupId: 'g14' });
    });

    it('still skips a destination equal to the source', () => {
      templateSkill('g15', 'widget', 'SKILL.md', 'body');
      const src = path.join(DATA_DIR, 'v2-sessions', 'g15', '.claude-shared', 'skills');

      materializeTemplateSkills('g15', src);

      expect(fs.existsSync(path.join(src, 'widget', 'SKILL.md'))).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
