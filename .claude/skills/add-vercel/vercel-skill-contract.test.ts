/**
 * Contract guard for add-vercel's own instructions (host tree, vitest).
 *
 * Every finding this file encodes was a line of prose that read as plausible
 * and did the wrong thing when a target agent executed it verbatim. Prose is
 * the skill's payload, so prose is what needs a regression guard: nothing else
 * in the repo goes red when a phase drifts back to the destructive shape.
 *
 * Unlike `vercel-manifest.test.ts` (the guard the skill copies into `src/`
 * during install, which asserts *applied* state), this file asserts only the
 * skill's own documents and is green on a pristine checkout. Both run under
 * `pnpm run test:skills`.
 *
 * Each assertion below names the failure it prevents. If a phase is
 * legitimately redesigned, update the assertion together with the prose — do
 * not delete it because it went red.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

const here = __dirname;
const skill = fs.readFileSync(path.join(here, 'SKILL.md'), 'utf8');
const remove = fs.readFileSync(path.join(here, 'REMOVE.md'), 'utf8');
const containerSkill = fs.readFileSync(
  path.join(here, 'container-skills', 'vercel-cli', 'SKILL.md'),
  'utf8',
);
const docs = { 'SKILL.md': skill, 'REMOVE.md': remove };

describe('add-vercel: shared-skill delivery uses the symlink model', () => {
  it('never rsyncs container skills into the per-group shared store', () => {
    // The old Phase 5 ran `rsync -a container/skills/ "$dir/.claude-shared/skills/"`,
    // replacing every symlink into the read-only /app/skills mount with a real
    // directory. That froze EVERY shared skill in EVERY existing group at the
    // bytes of that moment, and the host can only warn about it
    // (`syncSkillSymlinks`, src/container-runner.ts).
    for (const [name, text] of Object.entries(docs)) {
      const offending = text
        .split('\n')
        .filter((line) => /rsync/.test(line) && /\.claude-shared/.test(line));
      expect(offending, `${name} rsyncs into the per-group shared skills store`).toEqual([]);
    }
  });

  it('deletes only the vercel-cli name from the per-group store, never the whole store', () => {
    // A blanket `rm -rf "$dir/.claude-shared/skills"` (or a glob wider than the
    // one skill this file owns) would take template-stamped skills with it —
    // those are legitimately real directories at that path.
    for (const [name, text] of Object.entries(docs)) {
      const rms = text.split('\n').filter((line) => /rm -rf/.test(line) && /skills/.test(line));
      for (const line of rms) {
        expect(line, `${name}: over-broad delete in the shared skills store: ${line}`).toContain(
          'vercel-cli',
        );
      }
    }
  });

  it('explains that a real directory shadows the shared mount', () => {
    expect(skill).toMatch(/shadow/i);
  });
});

describe('add-vercel: container teardown is scoped to this install', () => {
  it('never filters containers by session label alone', () => {
    // `docker ps --filter label=nanoclaw-session` matches peer installs on the
    // same host. Trunk's own reaping joins on `nanoclaw-install=<slug>`
    // (src/drivers/docker-driver.ts) for exactly this reason.
    for (const [name, text] of Object.entries(docs)) {
      for (const line of text.split('\n')) {
        if (!/docker ps/.test(line)) continue;
        expect(line, `${name}: unscoped container filter: ${line}`).toContain('nanoclaw-install=');
      }
    }
  });

  it('offers the supported per-group restart path first', () => {
    for (const [name, text] of Object.entries(docs)) {
      expect(text, `${name} should use ncl groups restart`).toMatch(/ncl groups restart --id/);
    }
  });
});

describe('add-vercel: the OneCLI secret flow matches how OneCLI actually works', () => {
  it('gates pre-flight on gateway reachability, not on the binary existing', () => {
    // `onecli version` prints server_status in the same JSON. Gating on exit
    // code alone lets a dead gateway through and strands Phase 3 half-applied.
    // The gate is one shell pipeline, possibly wrapped across lines: `onecli
    // version` must feed a check on server_status before anything reports OK.
    expect(skill).toMatch(/onecli version[\s\S]{0,160}server_status[\s\S]{0,160}ONECLI_OK/);
  });

  it('treats `all` secret mode as the default and only assigns for selective agents', () => {
    // Auto-created agents default to `all`; a matching --host-pattern is then
    // enough. The old prose claimed the opposite and pushed every agent onto
    // the selective path.
    expect(skill).toMatch(/selectMode|secretMode/);
    expect(skill).toContain('select(.secretMode != "all")');
    expect(skill).not.toMatch(/OneCLI uses selective secret mode/);
  });

  it('merges assigned secret ids in jq, never by shell-joining a possibly empty list', () => {
    // `printf '%s' "$CURRENT,$ID" | tr ',' '\n' | sort -u | paste -sd ,` yields
    // a leading empty element when CURRENT is empty — which is the normal case —
    // and onecli rejects `--secret-ids ",sec-…"`.
    for (const [name, text] of Object.entries(docs)) {
      expect(text, `${name} shell-joins the secret id list`).not.toMatch(/paste -sd/);
      if (/set-secrets/.test(text)) {
        expect(text, `${name} should build the id list in jq`).toContain('if type == "object"');
      }
    }
  });

  it('keeps the header-injection flags on secrets create, since the auth story depends on them', () => {
    expect(skill).toContain('--header-name "Authorization"');
    expect(skill).toContain('--value-format "Bearer {value}"');
  });
});

describe('add-vercel: image installation is keyed on the image', () => {
  it('probes the built image for the binary rather than grepping the manifest', () => {
    // `grep -q '"vercel"' container/cli-tools.json && skip the rebuild` reports
    // done in exactly the broken state where the skill is loaded and the binary
    // is absent.
    expect(skill).toContain("command -v vercel");
    expect(skill).not.toMatch(/grep -q '"vercel"'[\s\S]*skip the rebuild/);
  });

  it('probes with a non-login shell, so /pnpm stays on PATH', () => {
    // `sh -lc` re-reads /etc/profile inside the image, which resets PATH
    // without /pnpm — where every global CLI installed from cli-tools.json
    // lives. Under -lc the probe reports the binary missing forever.
    for (const [name, text] of Object.entries(docs)) {
      for (const line of text.split('\n')) {
        if (!/docker run/.test(line)) continue;
        expect(line, `${name} probes the image with a login shell: ${line}`).not.toMatch(/\s-lc\b/);
      }
    }
  });

  it('derives the image name from the install slug helper', () => {
    // A hardcoded `nanoclaw-agent:latest` is another install's image (or none).
    expect(skill).toContain('setup/lib/install-slug.sh');
    expect(skill).toContain('container_image_base');
  });

  it('removal knows a bare rebuild cannot subtract on a pulled install', () => {
    // On NANOCLAW_HARDENED_IMAGE=true, build.sh layers `FROM` the tag that is
    // already there, so dropping the manifest entry leaves the binary in the
    // layer underneath. Verified: manifest cleaned + `./container/build.sh` →
    // `command -v vercel` still resolves. Only re-fetching the published image
    // replaces the tag.
    expect(remove).toContain('./container/build.sh pull');
    expect(remove).toMatch(/NANOCLAW_HARDENED_IMAGE/);
  });
});

describe('add-vercel: the container skill tells the truth about --token placeholder', () => {
  it('states the replace semantics rather than asserting a vague "OneCLI replaces it"', () => {
    expect(containerSkill).toMatch(/Authorization: Bearer/);
    expect(containerSkill).toMatch(/overwrit|replace/i);
  });

  it('gives the agent the failure signature to recognize an unrewritten placeholder', () => {
    expect(containerSkill).toContain("The token provided via '--token' argument is not valid");
  });

  it('never tells the agent to handle a real token itself', () => {
    expect(containerSkill).not.toMatch(/export VERCEL_TOKEN=/);
    expect(containerSkill).toMatch(/Do not ask the user to paste a token/);
  });
});
