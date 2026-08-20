/**
 * Delivery-seam guard for the add-karpathy-llm-wiki skill.
 *
 * The wiki schema — the text that turns the agent from a chatbot into a
 * disciplined wiki maintainer — is the whole point of this skill, and it only
 * counts if it survives into the project document the container actually
 * mounts. Two host seams decide that, and both are outside the skill:
 *
 *   1. `composeGroupClaudeMd` rewrites `groups/<folder>/CLAUDE.md` from scratch
 *      on every spawn. Text placed in that file is destroyed before the agent
 *      reads it; text placed in `instructions.prepend.md` is inlined as the
 *      persona fragment and imported first.
 *   2. `syncSkillSymlinks` prunes the per-group skill store on every spawn. A
 *      real per-group skill directory has to survive that prune, or the wiki
 *      skill vanishes on the next restart.
 *
 * Each case below goes red if its seam moves, including the negative one:
 * the day `CLAUDE.md` stops being generated, case 2 fails and this skill can
 * be simplified. Ships with the skill; apply copies it to
 * `src/wiki-delivery-seam.test.ts`.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-wiki-delivery-seam-test';
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-wiki-delivery-seam-test/groups',
}));

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { composeGroupClaudeMd } from './claude-md-compose.js';
import type { ContainerConfig } from './container-config.js';
import { syncSkillSymlinks } from './container-runner.js';
import { ensureContainerConfig } from './db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { PERSONA_PREPEND_FILE } from './group-persona.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

const BEGIN = '<!-- BEGIN karpathy-llm-wiki -->';
const END = '<!-- END karpathy-llm-wiki -->';

/** The shape the skill's Step 4c writes, trimmed to its load-bearing lines. */
const WIKI_SECTION = [
  BEGIN,
  '## Wiki',
  '',
  'Sources live in `sources/`, compiled knowledge in `wiki/`.',
  'Catalog: `wiki/index.md`. Chronology: `wiki/log.md`.',
  'Ingest sources one at a time; finish each before starting the next.',
  'Full workflow: the `wiki` skill.',
  END,
].join('\n');

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

async function seedGroup(ag: AgentGroup): Promise<string> {
  await createAgentGroup(ag);
  await ensureContainerConfig(ag.id);
  const dir = path.join(GROUPS_DIR, ag.folder);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Read the composed entry document and inline every `@./…` import it emits —
 * the same resolution the provider performs inside the container. Symlinked
 * fragments target container paths and are unreadable on the host, so they
 * contribute their target path instead of their body.
 */
function resolveComposedDocument(groupDir: string): string {
  const entry = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf-8');
  let text = entry;
  for (const line of entry.split('\n')) {
    const match = line.trim().match(/^@(\.\/.+)$/);
    if (!match) continue;
    const target = path.join(groupDir, match[1]);
    try {
      text += `\n${fs.readFileSync(target, 'utf-8')}`;
    } catch {
      text += `\n<!-- ${match[1]} -> ${fs.readlinkSync(target)} -->`;
    }
  }
  return text;
}

function importsOf(groupDir: string): string[] {
  return fs
    .readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf-8')
    .split('\n')
    .filter((line) => line.startsWith('@'));
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(GROUPS_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  vi.mocked(log.warn).mockClear();
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('wiki standing instructions', () => {
  it('reach the composed project document through instructions.prepend.md', async () => {
    const ag = group('ag-wiki-prepend', 'wiki-prepend');
    const dir = await seedGroup(ag);
    fs.writeFileSync(path.join(dir, PERSONA_PREPEND_FILE), `${WIKI_SECTION}\n`);

    await composeGroupClaudeMd(ag);

    // Imported first, so the wiki schema tops the composed system prompt.
    expect(importsOf(dir)[0]).toBe('@./.claude-fragments/persona.md');

    const composed = resolveComposedDocument(dir);
    expect(composed).toContain(BEGIN);
    expect(composed).toContain(END);
    expect(composed).toContain('wiki/index.md');
    expect(composed).toContain('wiki/log.md');
    expect(composed).toContain('one at a time');
  });

  it('survive a second compose, so a container restart keeps the wiki schema', async () => {
    const ag = group('ag-wiki-respawn', 'wiki-respawn');
    const dir = await seedGroup(ag);
    fs.writeFileSync(path.join(dir, PERSONA_PREPEND_FILE), `${WIKI_SECTION}\n`);

    await composeGroupClaudeMd(ag);
    await composeGroupClaudeMd(ag);

    expect(resolveComposedDocument(dir)).toContain(BEGIN);
  });

  it('are destroyed when written into the generated group CLAUDE.md', async () => {
    // The negative control for the seam above: `CLAUDE.md` is regenerated on
    // every spawn, so a marker block there never reaches the agent — which is
    // exactly why Step 4c targets the standing-instructions file instead.
    const ag = group('ag-wiki-claudemd', 'wiki-claudemd');
    const dir = await seedGroup(ag);
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# Group\n\n${WIKI_SECTION}\n`);

    await composeGroupClaudeMd(ag);

    const regenerated = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
    expect(regenerated).not.toContain(BEGIN);
    expect(regenerated).toContain('Composed at spawn - do not edit');
  });

  it('are not delivered by a container skill that ships only SKILL.md', async () => {
    // Step 4b installs a per-group skill, not a fragment: the composer's skill
    // fragments come from `container/skills/<name>/instructions.md`, so a
    // SKILL.md alone contributes no import. If that ever changes, this goes
    // red and the skill can lean on the fragment layer instead.
    const ag = group('ag-wiki-fragment', 'wiki-fragment');
    const dir = await seedGroup(ag);

    await composeGroupClaudeMd(ag);

    expect(importsOf(dir)).not.toContain('@./.claude-fragments/skill-wiki.md');
  });
});

describe('the per-group wiki skill', () => {
  const containerConfig = {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: ['welcome'],
  } as unknown as ContainerConfig;

  it('survives the spawn-time shared-skill sync', () => {
    const claudeDir = path.join(TEST_ROOT, 'v2-sessions', 'ag-wiki-skill', '.claude-shared');
    const wikiSkill = path.join(claudeDir, 'skills', 'wiki');
    fs.mkdirSync(wikiSkill, { recursive: true });
    fs.writeFileSync(path.join(wikiSkill, 'SKILL.md'), '---\nname: wiki\n---\n');

    syncSkillSymlinks(claudeDir, containerConfig);
    syncSkillSymlinks(claudeDir, containerConfig);

    // Real directory, not a symlink into the install-wide /app/skills mount:
    // that is what keeps the wiki skill scoped to this one agent group.
    expect(fs.lstatSync(wikiSkill).isDirectory()).toBe(true);
    expect(fs.lstatSync(wikiSkill).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(wikiSkill, 'SKILL.md'), 'utf-8')).toContain('name: wiki');
    // A shadowing warning here would mean a shared `container/skills/wiki`
    // exists too, which is the install-wide leak this skill must not create.
    expect(vi.mocked(log.warn).mock.calls.flat()).not.toContainEqual(expect.objectContaining({ skill: 'wiki' }));
  });
});
