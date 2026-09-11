import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { listSetupProviders } from './registry.js';
import {
  getInstallableProviderDescriptor,
  getProviderDescriptor,
  listInstallableProviderDescriptors,
  listProviderDescriptors,
  providerImagePolicy,
} from './skill-descriptor.js';
import './index.js'; // the real setup provider barrel — triggers self-registration

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('provider skill descriptors', () => {
  it('derives the Codex setup offer and image policy from add-codex frontmatter', () => {
    expect(getInstallableProviderDescriptor('CODEX')).toEqual({
      value: 'codex',
      label: 'Codex',
      hint: 'OpenAI — ChatGPT subscription or API key',
      installSkill: 'add-codex',
      image: 'local-required',
      offered: true,
      skillDir: path.join('.claude', 'skills', 'add-codex'),
    });
    expect(listInstallableProviderDescriptors().map((entry) => entry.value)).toEqual(['codex']);
    expect(providerImagePolicy('CODEX')).toBe('local-required');
    expect(providerImagePolicy('claude')).toBe('hardened-compatible');
    expect(providerImagePolicy('unknown-provider')).toBe('local-required');
  });

  it('offers exactly Codex on trunk and keeps OpenCode out of the setup picker', () => {
    // The picker (setup/auto.ts askAgentProviderChoice) lists installed setup
    // providers plus listInstallableProviderDescriptors(). OpenCode is a
    // skill-only provider: hidden from the offer AND never registered with
    // setup, so neither source can surface it.
    expect(listInstallableProviderDescriptors().map((entry) => entry.value)).toEqual(['codex']);
    const opencode = listProviderDescriptors().find((entry) => entry.value === 'opencode');
    expect(opencode?.offered).toBe(false);
    expect(getInstallableProviderDescriptor('opencode')).toBeUndefined();

    const addOpencode = fs.readFileSync(path.join('.claude', 'skills', 'add-opencode', 'SKILL.md'), 'utf-8');
    expect(addOpencode).not.toMatch(/^```nc:append to:setup\/providers\/index\.ts/m);
    expect(addOpencode).not.toMatch(/^setup\/providers\/opencode\.ts$/m);
  });

  it('never surfaces a descriptor with offered false in the installable list', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-descriptor-'));
    roots.push(root);
    const dir = path.join(root, '.claude', 'skills', 'add-hidden');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      [
        '---',
        'name: add-hidden',
        'description: hidden',
        'metadata:',
        '  nanoclaw-provider: hidden',
        '  nanoclaw-provider-label: Hidden',
        '  nanoclaw-provider-hint: skill-only',
        "  nanoclaw-provider-offered: 'false'",
        '  nanoclaw-provider-image: local-required',
        '---',
        '',
      ].join('\n'),
    );
    expect(listProviderDescriptors(root).map((entry) => [entry.value, entry.offered])).toEqual([['hidden', false]]);
    expect(listInstallableProviderDescriptors(root)).toEqual([]);
    expect(getInstallableProviderDescriptor('hidden', root)).toBeUndefined();
    // Hidden is not unknown: the image policy still comes from the descriptor.
    expect(providerImagePolicy('hidden', root)).toBe('local-required');
  });

  it('rejects the retired install-skill key so stale frontmatter fails loudly', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-descriptor-'));
    roots.push(root);
    const dir = path.join(root, '.claude', 'skills', 'add-stale');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      [
        '---',
        'name: add-stale',
        'description: stale',
        'metadata:',
        '  nanoclaw-provider: stale',
        '  nanoclaw-provider-label: Stale',
        '  nanoclaw-provider-hint: carries the retired key',
        "  nanoclaw-provider-offered: 'true'",
        '  nanoclaw-provider-install-skill: add-stale',
        '  nanoclaw-provider-image: local-required',
        '---',
        '',
      ].join('\n'),
    );
    expect(() => listProviderDescriptors(root)).toThrow(
      'add-stale: nanoclaw-provider-install-skill is no longer read; remove it (the skill directory is the install skill)',
    );
  });

  it('derives the install skill from the directory name, never from frontmatter', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-descriptor-'));
    roots.push(root);
    const dir = path.join(root, '.claude', 'skills', 'add-derived');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      [
        '---',
        'name: add-derived',
        'description: derived',
        'metadata:',
        '  nanoclaw-provider: derived',
        '  nanoclaw-provider-label: Derived',
        '  nanoclaw-provider-hint: no install-skill key',
        "  nanoclaw-provider-offered: 'true'",
        '  nanoclaw-provider-image: hardened-compatible',
        '---',
        '',
      ].join('\n'),
    );
    expect(getInstallableProviderDescriptor('derived', root)?.installSkill).toBe('add-derived');
    expect(getInstallableProviderDescriptor('derived', root)?.skillDir).toBe(path.join('.claude', 'skills', 'add-derived'));
  });

  it('rejects incomplete provider metadata instead of offering a partial install', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-descriptor-'));
    roots.push(root);
    const dir = path.join(root, '.claude', 'skills', 'add-broken');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\nname: add-broken\ndescription: broken\nmetadata:\n  nanoclaw-provider: broken\n---\n',
    );
    expect(() => listInstallableProviderDescriptors(root)).toThrow(/missing nanoclaw-provider-label/);
  });

  it('ignores malformed frontmatter that does not claim to describe a provider', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-descriptor-'));
    roots.push(root);
    const dir = path.join(root, '.claude', 'skills', 'unrelated');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: unrelated\ndescription: [broken\n');

    expect(listInstallableProviderDescriptors(root)).toEqual([]);
  });

  it('still rejects malformed frontmatter that claims to describe a provider', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-descriptor-'));
    roots.push(root);
    const dir = path.join(root, '.claude', 'skills', 'add-broken');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nmetadata:\n  nanoclaw-provider: broken\n');

    expect(() => listInstallableProviderDescriptors(root)).toThrow(/frontmatter is missing the closing/);
  });
});

describe('setup entry and descriptor labels stay in sync', () => {
  // A provider is labelled twice on purpose: the descriptor labels the offer
  // before install (the entry does not exist yet), the registered
  // SetupProviderEntry labels it after. Claude has no descriptor and an
  // uninstalled provider has no entry, so on bare trunk no pair exists — the
  // install-time verifier (scripts/provider-contract-verifier.ts) runs the
  // setup/providers tests in the installed tree, where the pair exists and
  // drift goes red.
  it('every registered provider with a descriptor carries the same label and hint in both', () => {
    for (const entry of listSetupProviders()) {
      const descriptor = getProviderDescriptor(entry.value);
      if (!descriptor) continue;
      expect([entry.value, entry.label, entry.hint]).toEqual([entry.value, descriptor.label, descriptor.hint]);
    }
  });
});
