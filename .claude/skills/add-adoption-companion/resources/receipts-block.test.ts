/**
 * Static / structural tests for the Memory Receipts companion tip
 * (Adoption Companion pack).
 * Design spec §A1 (block-template invariants), §A2 (helper unit tests),
 * §A3 (skill wiring). Deterministic, never calls an LLM.
 *
 * Ships with the skill and is copied to src/ at install, alongside the helper
 * it guards. Run: pnpm exec vitest run src/adoption-receipts-block.test.ts
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

import {
  RECEIPTS_VERSION,
  renderReceiptsBlock,
  applyReceiptsBlock,
  removeReceiptsBlock,
} from './adoption-receipts-block.js';

const SKILL_DIR = path.resolve(__dirname, '../.claude/skills/add-adoption-companion');
const read = (rel: string) => fs.readFileSync(path.join(SKILL_DIR, rel), 'utf8');

const OPEN = `<!-- adoption:receipts v=${RECEIPTS_VERSION} -->`;
const CLOSE = '<!-- /adoption:receipts -->';

// ---------------------------------------------------------------------------
// A1 — Block-template invariants
// ---------------------------------------------------------------------------
describe('A1 — block-template invariants', () => {
  const block = renderReceiptsBlock(RECEIPTS_VERSION, 'OFF');

  it('A1.1 balanced markers: exactly one open and one close', () => {
    expect(block.match(/<!-- adoption:receipts v=\d+ -->/g)).toHaveLength(1);
    expect(block.match(/<!-- \/adoption:receipts -->/g)).toHaveLength(1);
  });

  it('A1.2 version agreement: marker v= equals the declared version constant', () => {
    const marker = block.match(/<!-- adoption:receipts v=(\d+) -->/);
    expect(marker).not.toBeNull();
    expect(Number(marker![1])).toBe(RECEIPTS_VERSION);
  });

  it('A1.3 rendered state line is exactly **Receipts: <state>.**', () => {
    expect(block).toContain('**Receipts: OFF.**');
    expect(renderReceiptsBlock(RECEIPTS_VERSION, 'ON')).toContain('**Receipts: ON.**');
  });

  it('A1.4 guard clause present', () => {
    expect(block).toContain('Applies only when `memory/index.md` is your active memory store');
  });

  it('A1.5 toggle instructions present: flip ON/OFF + immediate, no-restart', () => {
    expect(block).toMatch(/turn it on or off/i);
    expect(block).toMatch(/no restart is needed/i);
    expect(block).toContain('**Receipts:**');
  });

  it('A1.7 cold-turn clause present (works on first message; no greeting instead of engaging)', () => {
    expect(block).toMatch(/first message of a session/i);
    expect(block).toMatch(/greeting/i);
  });

  it('A1.6 no jargon in user-facing example strings', () => {
    const blocklist = [
      'memory/',
      'index.md',
      'instructions.prepend.md',
      'OKF',
      'concept file',
      'entity type',
      'Core Memory',
      'frontmatter',
    ];
    // Only the strings shown to the user as examples (the 📝 lines) are checked.
    const exampleLines = block.split('\n').filter((l) => l.includes('📝'));
    expect(exampleLines.length).toBeGreaterThan(0);
    for (const line of exampleLines) {
      for (const term of blocklist) {
        expect(line).not.toContain(term);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// A2 — Block-mutation helper (apply / remove)
// ---------------------------------------------------------------------------
describe('A2 — apply/remove helper', () => {
  const markerCount = (t: string) => (t.match(/<!-- adoption:receipts v=\d+ -->/g) || []).length;

  it('A2.1 apply to file with no marker: appended once, prior content preserved', () => {
    const prior = 'You are Nano, a helpful assistant.\n\n## Tone\nBe terse.\n';
    const out = applyReceiptsBlock(prior, { version: 1 });
    expect(markerCount(out)).toBe(1);
    expect(out).toContain('You are Nano, a helpful assistant.');
    expect(out).toContain('## Tone\nBe terse.');
  });

  it('A2.1b fresh install ships ON — installing the tip is the opt-in', () => {
    expect(applyReceiptsBlock('persona\n', { version: 1 })).toContain('**Receipts: ON.**');
    expect(applyReceiptsBlock('', { version: 1 })).toContain('**Receipts: ON.**');
  });

  it('A2.2 apply twice is idempotent (byte-identical, no duplicate)', () => {
    const prior = 'persona text\n';
    const once = applyReceiptsBlock(prior, { version: 1 });
    const twice = applyReceiptsBlock(once, { version: 1 });
    expect(twice).toBe(once);
    expect(markerCount(twice)).toBe(1);
  });

  it('A2.3 update v1→v2 preserves ON', () => {
    const v1 = `persona\n\n${renderReceiptsBlock(1, 'ON')}\n`;
    const v2 = applyReceiptsBlock(v1, { version: 2 });
    expect(v2).toContain('<!-- adoption:receipts v=2 -->');
    expect(v2).toContain('**Receipts: ON.**');
    expect(markerCount(v2)).toBe(1);
  });

  it('A2.4 update v1→v2 preserves a user OFF — a re-install never flips it back on', () => {
    const v1 = `persona\n\n${renderReceiptsBlock(1, 'OFF')}\n`;
    const v2 = applyReceiptsBlock(v1, { version: 2 });
    expect(v2).toContain('<!-- adoption:receipts v=2 -->');
    expect(v2).toContain('**Receipts: OFF.**');
    expect(v2).not.toContain('**Receipts: ON.**');
  });

  it('A2.5 garbled state line on update falls back to the shipped default (ON)', () => {
    const garbled = renderReceiptsBlock(1, 'OFF').replace(
      '**Receipts: OFF.**  (Flip',
      '**Receipts: MAYBE.**  (Flip',
    );
    const out = applyReceiptsBlock(`persona\n\n${garbled}\n`, { version: 2 });
    expect(out).toContain('**Receipts: ON.**');
  });

  it('A2.6 apply to empty / whitespace-only file: written, no crash', () => {
    expect(markerCount(applyReceiptsBlock('', { version: 1 }))).toBe(1);
    expect(markerCount(applyReceiptsBlock('   \n\t\n', { version: 1 }))).toBe(1);
  });

  it('A2.7 remove deletes exactly the block span; surrounding persona intact', () => {
    const installed = applyReceiptsBlock('top persona\n\nbottom persona\n', { version: 1 });
    const removed = removeReceiptsBlock(installed);
    expect(markerCount(removed)).toBe(0);
    expect(removed).toContain('top persona');
    expect(removed).toContain('bottom persona');
    expect(removed).not.toMatch(/\n{3,}/);
  });

  it('A2.8 remove is idempotent when no marker present', () => {
    const plain = 'just a persona, no block\n';
    expect(removeReceiptsBlock(plain)).toBe(plain);
  });

  it('A2.9 remove leaves sibling adoption:* blocks intact', () => {
    const sibling =
      '<!-- adoption:digest v=1 -->\n## Digest\nbody\n<!-- /adoption:digest -->\n';
    const installed = applyReceiptsBlock(`${sibling}\npersona\n`, { version: 1 });
    const removed = removeReceiptsBlock(installed);
    expect(removed).toContain('<!-- adoption:digest v=1 -->');
    expect(removed).toContain('<!-- /adoption:digest -->');
    expect(markerCount(removed)).toBe(0);
  });

  it('A2.10 malformed block (open, no close) is not corrupted — throws, no partial delete', () => {
    const malformed = `persona\n${OPEN}\n## Memory receipts\n**Receipts: ON.**\n`;
    expect(() => applyReceiptsBlock(malformed, { version: 1 })).toThrow(/unbalanced/i);
    expect(() => removeReceiptsBlock(malformed)).toThrow(/unbalanced/i);
  });

  it('A2.11 CRLF / trailing whitespace tolerated; state parsed; output stable', () => {
    const crlf = 'persona line\r\n\r\n'.concat(
      renderReceiptsBlock(1, 'ON').replace(/\n/g, '\r\n'),
      '\r\n',
    );
    const out = applyReceiptsBlock(crlf, { version: 1 });
    expect(out).toContain('**Receipts: ON.**');
    expect(applyReceiptsBlock(out, { version: 1 })).toBe(out); // stable
  });

  it('A2.12 two blocks accidentally present: apply de-dupes; remove clears all', () => {
    const one = renderReceiptsBlock(1, 'OFF');
    const doubled = `persona\n\n${one}\n\n${one}\n`;
    const applied = applyReceiptsBlock(doubled, { version: 1 });
    expect(markerCount(applied)).toBe(1);
    expect(markerCount(removeReceiptsBlock(doubled))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A3 — Skill wiring (read the artifact, assert presence)
// ---------------------------------------------------------------------------
describe('A3 — skill wiring', () => {
  const skill = read('SKILL.md');
  const remove = read('REMOVE.md');

  it('A3.1 SKILL.md has the three steps: guard, insert block, report', () => {
    expect(skill.toLowerCase()).toContain('guard');
    expect(skill.toLowerCase()).toMatch(/insert (the )?block/);
    expect(skill.toLowerCase()).toContain('report');
  });

  it('A3.2 guard names BOTH conditions (memory/index.md AND no residual CLAUDE.local.md)', () => {
    expect(skill).toContain('memory/index.md');
    expect(skill).toContain('CLAUDE.local.md');
  });

  it('A3.3 SKILL.md references `ncl groups list` and states per-group repetition', () => {
    expect(skill).toContain('ncl groups list');
    expect(skill.toLowerCase()).toMatch(/per (target )?group|repeat/);
  });

  it('A3.4 REMOVE.md targets the receipts markers and is skip-if-absent', () => {
    expect(remove).toContain('adoption:receipts');
    expect(remove.toLowerCase()).toMatch(/skip|idempotent|already gone|absent/);
  });

  it('A3.5 SKILL.md documents every tip the pack ships, and each one\'s scope', () => {
    // The pack accretes tips. Its header went stale the first time that
    // happened: the description still said "ships with the Memory Receipts
    // tip" after Knowledge Inventory landed, and called the install
    // per-group when the new tip is fork-wide. The description is what
    // decides when the skill is invoked and what a user thinks they get, so
    // adding a tip must update it. Add the new tip's name here when you add one.
    for (const tip of ['Memory Receipts', 'Knowledge Inventory']) {
      expect(skill).toContain(tip);
    }
    expect(skill).toMatch(/per agent group|one agent group/i);
    expect(skill).toMatch(/every group in the fork|fork-level/i);
  });

  it('A3.6 marker strings in SKILL.md/REMOVE.md match the template exactly', () => {
    expect(skill).toContain(OPEN);
    expect(skill).toContain(CLOSE);
    expect(remove).toContain(CLOSE);
    // no drift: the SKILL marker equals the rendered template's marker
    expect(renderReceiptsBlock(RECEIPTS_VERSION, 'OFF')).toContain(OPEN);
  });
});
