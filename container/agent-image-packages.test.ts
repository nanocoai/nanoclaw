import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

/**
 * Every package a composed template declares is baked into the agent image.
 *
 * On the pod driver there is no per-agent-group image build, so a template's
 * packages/apt.txt is a contract the runtime image has to satisfy, and the only
 * moment anyone can prove that is here, at compose time. Reverting the
 * Dockerfile edit, or a template declaring a package the image lacks, both
 * fail this test — naming the package and the template, before a provision
 * fails naming neither.
 */
const ROOT = process.cwd();
const DOCKERFILE = path.join(ROOT, 'container', 'Dockerfile');
const TEMPLATES = path.join(ROOT, 'templates');

const list = (file: string): string[] =>
  fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    : [];

/** Package names inside `apt-get install` continuation blocks. */
function bakedApt(dockerfile: string): Set<string> {
  const out = new Set<string>();
  let inInstall = false;
  for (const raw of dockerfile.split('\n')) {
    const line = raw.trim().replace(/\\$/, '').trim();
    if (/apt-get install/.test(raw)) inInstall = true;
    if (inInstall) {
      for (const word of line.split(/\s+/)) if (/^[a-z0-9][a-z0-9+.-]*$/.test(word) && !['apt-get', 'install', '-y', 'update', '&&'].includes(word)) out.add(word);
      if (!raw.trim().endsWith('\\')) inInstall = false;
    }
  }
  return out;
}

const templates = fs.existsSync(TEMPLATES)
  ? fs.readdirSync(TEMPLATES).filter((n) => fs.existsSync(path.join(TEMPLATES, n, 'plugin.json')))
  : [];

describe('the agent image carries what the composed templates declare', () => {
  it('has the Dockerfile edit at all', () => {
    const text = fs.readFileSync(DOCKERFILE, 'utf8');
    expect(bakedApt(text).has('jq')).toBe(true);
    expect(bakedApt(text).has('ripgrep')).toBe(true);
  });

  for (const name of templates) {
    it(`${name}: every apt package is baked, and no npm package is declared`, () => {
      const baked = bakedApt(fs.readFileSync(DOCKERFILE, 'utf8'));
      const apt = list(path.join(TEMPLATES, name, 'packages', 'apt.txt'));
      const missing = apt.filter((p) => !baked.has(p));
      expect(missing, `${name} declares apt packages the agent image does not carry: ${missing.join(', ')} — add them to container/Dockerfile via agent-image-packages`).toEqual([]);
      // No global npm install exists in the image today; a template that
      // declares one needs the skill extended, not a silent skip.
      const npm = list(path.join(TEMPLATES, name, 'packages', 'npm.txt'));
      expect(npm, `${name} declares npm packages; the agent image has no global npm install — extend agent-image-packages`).toEqual([]);
    });
  }
});
