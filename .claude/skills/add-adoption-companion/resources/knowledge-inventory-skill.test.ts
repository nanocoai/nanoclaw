import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Content invariants for the Knowledge Inventory container skill.
//
// Ships with the pack and is copied to src/ at install. It reads the *installed*
// skill at container/skills/, so it doubles as install verification: it goes red
// if Step 5b did not land the file, as well as if the content drifts.
//
// The feature is zero runtime code — prose plus the existing send_file /
// send_message tools — so there is no helper to unit-test. These read the
// shipped artifact and assert the invariants the spec pins down: the trigger
// contract, the guard, the counting rule, and the no-jargon rule.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_PATH = 'container/skills/knowledge-inventory/SKILL.md';

const skill = readFileSync(join(repoRoot, SKILL_PATH), 'utf8');

// Terms that describe storage internals. Fine in behavioral prose (the agent
// has to be told what to read); never in a string the user is shown.
const JARGON = [
  'memory/',
  'index.md',
  'concept file',
  'OKF',
  'entity type',
  'frontmatter',
  'Core Memory',
  'CLAUDE.local.md',
  '/workspace',
  // Added after a live eval: an agent said "my memory's still just the empty
  // scaffold" on an empty group. Not in the spec's blocklist, but it is
  // storage vocabulary reaching the user. See evals/knowledge-inventory/RESULTS.md.
  'scaffold',
];

/** Example output = a ```text example-output fence. Those are shown to users. */
function exampleOutputs(md: string): string[] {
  return [...md.matchAll(/```text example-output\n([\s\S]*?)```/g)].map((m) => m[1]);
}

describe('A1 — knowledge-inventory SKILL.md', () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';

  it('A1.1 has frontmatter with the right name and a description', () => {
    expect(frontmatter).toMatch(/^name: knowledge-inventory$/m);
    expect(frontmatter).toMatch(/^description: \S.+/m);
  });

  it('A1.2 description names the reactive triggers (this is what model-invokes it)', () => {
    const description = frontmatter.match(/^description: (.+)$/m)?.[1] ?? '';
    for (const trigger of ['what you know', 'remember', 'track']) {
      expect(description.toLowerCase()).toContain(trigger);
    }
  });

  it('A1.3 guards on the active store and degrades honestly', () => {
    expect(skill).toContain('memory/index.md');
    // Forward-to-operator phrasing, never "run this yourself".
    expect(skill).toMatch(/forward|pass this to whoever set me up/i);
    expect(skill).toMatch(/do \*\*not\*\* improvise|do not improvise/i);
  });

  it('A1.4 reads Core Memory + walks folder indexes, and counts rather than invents', () => {
    expect(skill).toMatch(/Core Memory/);
    expect(skill).toMatch(/walk the folder .*index\.md/i);
    expect(skill).toMatch(/count.*from the folders/i);
    expect(skill).toMatch(/never estimate, round, or infer/i);
  });

  it('A1.5 carries the translation rules and the no-jargon rule', () => {
    expect(skill).toMatch(/About you/);
    expect(skill).toMatch(/user's (vocabulary|words)/i);
    expect(skill).toMatch(/Your customers — 12/);
    // The no-jargon rule must enumerate the blocklist for the agent.
    expect(skill).toMatch(/Never say, in any surface/i);
    for (const term of ['concept file', 'OKF', 'entity type', 'frontmatter']) {
      expect(skill).toContain(term);
    }
  });

  it('A1.5b states no-jargon as a principle, not just a word list', () => {
    // Regression: "scaffold" leaked past an enumerated blocklist on a live run,
    // because a list can only ban words someone thought of. The skill must
    // carry the generative rule too.
    expect(skill).toMatch(/list is examples, not the whole rule/i);
    expect(skill).toMatch(/no word that describes how your memory is built/i);
    expect(skill).toContain('scaffold');
  });

  it('A1.5c requires every mapped folder to be reported, except system/', () => {
    // Regression: a live run silently dropped an operational folder (context/)
    // from the inventory. Spec §2 says report the categories the map points at;
    // system/ (the memory's own definition) is the one legitimate exclusion.
    expect(skill).toMatch(/Report every folder the map points at/i);
    expect(skill).toMatch(/system\//);
    expect(skill).toMatch(/[Dd]on't silently drop a category/);
  });

  it('A1.6 names both rendering surfaces', () => {
    expect(skill).toContain('send_file');
    expect(skill).toMatch(/self-contained/i);
    expect(skill).toMatch(/no external (stylesheets|assets)/i);
    expect(skill).toContain('send_message');
    expect(skill).toMatch(/plain text.*always available/i);
  });

  it('A1.7 offers control (add / fix / stop tracking)', () => {
    expect(skill).toMatch(/add something, fix anything, or stop tracking/i);
    expect(skill).toContain('system/definition.md');
  });

  it('A1.8 no jargon in user-facing example strings', () => {
    const examples = exampleOutputs(skill);
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      for (const term of JARGON) {
        expect(example).not.toContain(term);
      }
    }
  });
});
