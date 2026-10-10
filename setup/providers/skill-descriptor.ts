import fs from 'fs';
import path from 'path';

import { parse } from 'yaml';

export interface InstallableProviderDescriptor {
  value: string;
  label: string;
  hint: string;
  installSkill: string;
  image: 'local-required' | 'hardened-compatible';
  offered: boolean;
  skillDir: string;
}

const PREFIX = 'nanoclaw-provider-';

/** Read setup offers from the audited provider skills already in this checkout. */
export function listInstallableProviderDescriptors(projectRoot = process.cwd()): InstallableProviderDescriptor[] {
  return listProviderDescriptors(projectRoot).filter((descriptor) => descriptor.offered);
}

/** Parse every provider descriptor, including intentionally hidden offers. */
export function listProviderDescriptors(projectRoot = process.cwd()): InstallableProviderDescriptor[] {
  const skillsRoot = path.join(projectRoot, '.claude', 'skills');
  let entries: string[];
  try {
    entries = fs.readdirSync(skillsRoot).sort();
  } catch {
    return [];
  }

  const descriptors: InstallableProviderDescriptor[] = [];
  for (const entry of entries) {
    const skillFile = path.join(skillsRoot, entry, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    const descriptor = parseProviderDescriptor(fs.readFileSync(skillFile, 'utf-8'), entry);
    if (descriptor) descriptors.push({ ...descriptor, skillDir: path.join('.claude', 'skills', entry) });
  }
  return descriptors;
}

export function getInstallableProviderDescriptor(
  provider: string,
  projectRoot = process.cwd(),
): InstallableProviderDescriptor | undefined {
  return listInstallableProviderDescriptors(projectRoot).find((entry) => entry.value === provider.toLowerCase());
}

export function getProviderDescriptor(
  provider: string,
  projectRoot = process.cwd(),
): InstallableProviderDescriptor | undefined {
  return listProviderDescriptors(projectRoot).find((entry) => entry.value === provider.toLowerCase());
}

export function providerImagePolicy(
  provider: string,
  projectRoot = process.cwd(),
): 'local-required' | 'hardened-compatible' {
  const normalized = provider.toLowerCase();
  return (
    getProviderDescriptor(normalized, projectRoot)?.image ??
    (normalized === 'claude' ? 'hardened-compatible' : 'local-required')
  );
}

export function parseProviderDescriptor(
  markdown: string,
  directory: string,
): Omit<InstallableProviderDescriptor, 'skillDir'> | undefined {
  const lines = markdown.split('\n');
  if (lines[0] !== '---') return undefined;
  if (!/^\s*nanoclaw-provider\s*:/m.test(markdown)) return undefined;
  const closing = lines.indexOf('---', 1);
  if (closing === -1) throw new Error(`${directory}/SKILL.md frontmatter is missing the closing ---`);
  const frontmatter = parse(lines.slice(1, closing).join('\n')) as { metadata?: Record<string, unknown> };
  const metadata = frontmatter?.metadata;
  const value = text(metadata?.[`${PREFIX.slice(0, -1)}`]);
  if (!value) return undefined;

  const label = required(metadata, 'label', directory);
  const hint = required(metadata, 'hint', directory);
  const offered = required(metadata, 'offered', directory);
  const image = required(metadata, 'image', directory);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Error(`${directory}: invalid provider '${value}'`);
  if (offered !== 'true' && offered !== 'false') throw new Error(`${directory}: invalid offered value '${offered}'`);
  // The install skill IS the directory the descriptor lives in — a separate key
  // could only ever repeat it. Stale frontmatter fails loudly instead of being
  // silently ignored.
  if (metadata?.[`${PREFIX}install-skill`] !== undefined) {
    throw new Error(
      `${directory}: ${PREFIX}install-skill is no longer read; remove it (the skill directory is the install skill)`,
    );
  }
  if (image !== 'local-required' && image !== 'hardened-compatible') {
    throw new Error(`${directory}: invalid provider image policy '${image}'`);
  }
  return { value, label, hint, installSkill: directory, image, offered: offered === 'true' };
}

function required(metadata: Record<string, unknown> | undefined, key: string, directory: string): string {
  const value = text(metadata?.[`${PREFIX}${key}`]);
  if (!value) throw new Error(`${directory}: missing ${PREFIX}${key}`);
  return value;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
