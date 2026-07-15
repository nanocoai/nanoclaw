// Regression coverage for the add-whatsapp SKILL.md's shared-number steps —
// the port of the deleted setup/channels/whatsapp.ts helpers. The skill now
// carries the behavior as directive fences, so these tests extract the actual
// fence bodies from the document and execute them the way the apply engine
// would (bash -c, {{vars}} substituted in). If someone edits the skill and
// breaks the engage-pattern semantics or the replace-not-append .env writes,
// this goes red.
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseDirectives, type Directive } from '../../scripts/skill-directives.js';

const SKILL_MD = path.join(process.cwd(), '.claude/skills/add-whatsapp/SKILL.md');
const directives = parseDirectives(fs.readFileSync(SKILL_MD, 'utf-8'));

function runFence(pred: (d: Directive) => boolean): Directive {
  const d = directives.find((x) => x.kind === 'run' && pred(x));
  if (!d) throw new Error('expected run fence not found in add-whatsapp SKILL.md');
  return d;
}

// Substitute {{vars}} the way the engine does, then run through bash -c in cwd.
function bash(body: string[], vars: Record<string, string>, cwd: string): string {
  const cmd = body
    .join('\n')
    .replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, name) => {
      const v = vars[name];
      if (v === undefined) throw new Error(`unresolved {{${name}}}`);
      return v;
    });
  return execFileSync('bash', ['-c', cmd], { cwd, encoding: 'utf-8' });
}

describe('self-chat engage pattern fence', () => {
  const fence = runFence((d) => d.attrs.capture === 'engage_pattern');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-engage-'));
  const patternFor = (name: string): string => bash(fence.body, { agent_name: name }, dir).trim();

  it('matches messages starting with @<name> and nothing else', () => {
    const re = new RegExp(patternFor('Nano'));
    expect(re.test('@Nano what time is it?')).toBe(true);
    expect(re.test('@Nano')).toBe(true);
    expect(re.test('hey @Nano')).toBe(false);
    expect(re.test('grocery list')).toBe(false);
    // \b guard: name must end at a word boundary, not prefix a longer word.
    expect(re.test('@Nanobot hello')).toBe(false);
  });

  it('escapes regex metacharacters in the agent name', () => {
    const re = new RegExp(patternFor('C-3PO (backup)'));
    expect(re.test('@C-3PO (backup) status?')).toBe(true);
    expect(re.test('@C-3PO Xbackup) status?')).toBe(false);
  });

  it('drops the trailing \\b for names ending in non-word characters', () => {
    const pattern = patternFor('Nano!');
    expect(pattern.endsWith('\\b')).toBe(false);
    expect(new RegExp(pattern).test('@Nano! do the thing')).toBe(true);
  });
});

describe('.env write fences (replace, not append)', () => {
  const dedicated = runFence(
    (d) => d.attrs.when === 'mode=dedicated' && d.body.join(' ').includes('ASSISTANT_HAS_OWN_NUMBER=true'),
  );
  const shared = runFence(
    (d) => d.attrs.when === 'mode=shared' && d.body.join(' ').includes('ASSISTANT_HAS_OWN_NUMBER=false'),
  );
  const name = runFence((d) => d.body.join(' ').includes('ASSISTANT_NAME='));

  let dir: string;
  const env = (): string => fs.readFileSync(path.join(dir, '.env'), 'utf-8');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-env-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates .env when missing', () => {
    bash(dedicated.body, {}, dir);
    expect(env()).toBe('ASSISTANT_HAS_OWN_NUMBER=true\n');
  });

  it('a mode-switching re-run replaces the flag — no stale true left behind', () => {
    bash(dedicated.body, {}, dir);
    bash(shared.body, {}, dir);
    const lines = env().split('\n').filter((l) => l.startsWith('ASSISTANT_HAS_OWN_NUMBER='));
    expect(lines).toEqual(['ASSISTANT_HAS_OWN_NUMBER=false']);
    expect(env()).not.toContain('=true');
  });

  it('flag write leaves neighboring keys untouched', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'TZ=UTC\nASSISTANT_HAS_OWN_NUMBER=true\n');
    bash(shared.body, {}, dir);
    expect(env()).toContain('TZ=UTC');
    expect(env()).toContain('ASSISTANT_HAS_OWN_NUMBER=false');
    expect(env()).not.toContain('ASSISTANT_HAS_OWN_NUMBER=true');
  });

  it('ASSISTANT_NAME: creates, then replaces on re-run, preserving neighbors', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'TZ=UTC\n');
    bash(name.body, { agent_name: 'Andy' }, dir);
    bash(name.body, { agent_name: 'Nano' }, dir);
    const lines = env().split('\n').filter(Boolean);
    expect(lines).toContain('TZ=UTC');
    expect(lines.filter((l) => l.startsWith('ASSISTANT_NAME='))).toEqual(['ASSISTANT_NAME=Nano']);
  });

  it('ASSISTANT_NAME keeps pattern-like values literal', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'ASSISTANT_NAME=Andy\n');
    bash(name.body, { agent_name: '$& $1' }, dir);
    expect(env().split('\n')).toContain('ASSISTANT_NAME=$& $1');
  });

  it('ASSISTANT_NAME handles names with spaces and metacharacters', () => {
    bash(name.body, { agent_name: 'C-3PO (backup)' }, dir);
    expect(env().split('\n')).toContain('ASSISTANT_NAME=C-3PO (backup)');
  });
});
