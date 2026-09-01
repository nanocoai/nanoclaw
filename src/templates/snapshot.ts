import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { parseTemplate, type Template } from './parse.js';

export interface TemplateSnapshot extends Template {
  /** Stable content identity for optimistic template stamping. */
  digest: string;
  /**
   * Raw policies/policy.json.
   * Nanoco validates it and combines it with assigned customer policies.
   */
  templatePolicy: unknown;
  /** Template-owned packages, installed exactly as declared. */
  packages: { apt: string[]; npm: string[] };
}

function readPackageList(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function regularFiles(dir: string, prefix = ''): string[] {
  return fs
    .readdirSync(path.join(dir, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const relative = path.posix.join(prefix.split(path.sep).join(path.posix.sep), entry.name);
      if (entry.name === '.git') return [];
      if (entry.isDirectory()) return regularFiles(dir, relative);
      return entry.isFile() ? [relative] : [];
    })
    .sort();
}

export function templateDigest(dir: string): string {
  const hash = createHash('sha256');
  for (const relative of regularFiles(dir)) {
    const content = fs.readFileSync(path.join(dir, relative));
    const name = Buffer.from(relative, 'utf8');
    hash.update(String(name.length));
    hash.update(':');
    hash.update(name);
    hash.update(String(content.length));
    hash.update(':');
    hash.update(content);
  }
  return `sha256:${hash.digest('hex')}`;
}

export function loadTemplateSnapshot(dir: string): TemplateSnapshot {
  const base = parseTemplate(dir);
  const policyFile = path.join(dir, 'policies', 'policy.json');
  const templatePolicy = fs.existsSync(policyFile) ? JSON.parse(fs.readFileSync(policyFile, 'utf8')) : {};
  const packagesDir = path.join(dir, 'packages');

  return {
    ...base,
    digest: templateDigest(dir),
    templatePolicy,
    packages: {
      apt: readPackageList(path.join(packagesDir, 'apt.txt')),
      npm: readPackageList(path.join(packagesDir, 'npm.txt')),
    },
  };
}
