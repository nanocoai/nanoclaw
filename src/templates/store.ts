/**
 * The stored template library: `agent_templates` in the central database.
 *
 * WHY A STORE. The Host is meant to be stateless, and a template library on
 * the node's disk is state the Host depends on and the deploy cannot write.
 * Here a template is a row: pushed over `ncl templates put` by whoever owns it
 * (the deploy for a release's templates, the seed script for its assistant, an
 * operator by hand), keyed by name, proven by digest.
 *
 * WHY MATERIALIZE. The parser, the snapshot and the stamper all read a
 * DIRECTORY, and that contract is upstream NanoClaw's. So a stored template is
 * unpacked into an ephemeral directory keyed by its digest and handed to them
 * unchanged. The directory is a cache of the row, never the other way round:
 * `templates/` on disk stays the local dev library (`TEMPLATES_DIR`, which
 * config.ts says is never remote and never runtime-mutable — and it still
 * isn't; this is a second source, not a change to that one).
 *
 * One digest definition. `putTemplate` computes the digest with the same
 * `templateDigest(dir)` the snapshot reports, over the materialized bundle, so
 * what the deploy verified and what `ncl templates get` shows are one number.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getDb } from '../db/connection.js';
import { materializeBundle, parseBundle, type TemplateBundle } from './bundle.js';
import { parseTemplate } from './parse.js';
import { templateDigest } from './snapshot.js';

const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const SOURCE_RE = /^[a-z0-9][a-z0-9:._-]{0,127}$/;

export interface StoredTemplateRow {
  name: string;
  digest: string;
  source: string;
  updated_at: string;
}

export interface StoredTemplate extends StoredTemplateRow {
  bundle: TemplateBundle;
}

export interface PutResult {
  name: string;
  digest: string;
  /** False when a row with this exact digest was already stored. */
  changed: boolean;
  /** The digest that was stored before this call, or null for a new name —
   *  what lets a caller tell "create" from "repair" without a second read. */
  previousDigest: string | null;
  /** True when nothing was written (`--dry-run`). */
  dryRun: boolean;
}

export function assertTemplateName(name: string): void {
  if (!NAME_RE.test(name) || name.length > 64) throw new Error(`invalid template name: ${JSON.stringify(name)}`);
}

/** Where a stored template is unpacked. Keyed by digest so a re-put with the
 *  same content reuses the directory and a changed one never overwrites. */
export function materializedDir(name: string, digest: string): string {
  return path.join(os.tmpdir(), 'nanoclaw-templates', `${name}-${digest.slice(0, 16)}`);
}

/** Unpack a bundle into its digest-keyed directory, validating it parses as a
 *  template whose plugin name matches. Returns the directory and the digest. */
export function materializeTemplate(name: string, bundle: TemplateBundle): { dir: string; digest: string } {
  assertTemplateName(name);
  // Materialize once into a scratch dir to learn the digest, then move into
  // place under that digest. A second put of identical content finds the
  // final dir already present and touches nothing.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-template-put-'));
  const staged = path.join(scratch, name);
  try {
    materializeBundle(bundle, staged);
    const plugin = parseTemplate(staged);
    if (plugin.report.length) throw new Error(`template ${name} does not parse: ${plugin.report.join('; ')}`);
    if (plugin.name !== name) throw new Error(`template bundle declares plugin name ${JSON.stringify(plugin.name)}, not ${JSON.stringify(name)}`);
    const digest = templateDigest(staged);
    const dir = materializedDir(name, digest);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
      fs.renameSync(staged, dir);
    }
    return { dir, digest };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export async function putTemplate(
  name: string,
  bundle: TemplateBundle,
  source: string,
  options: { dryRun?: boolean } = {},
): Promise<PutResult> {
  assertTemplateName(name);
  if (!SOURCE_RE.test(source)) throw new Error(`invalid template source: ${JSON.stringify(source)}`);
  const { digest } = materializeTemplate(name, bundle);
  const existing = await getDb().get<{ digest: string }>('SELECT digest FROM agent_templates WHERE name = ?', name);
  const changed = existing?.digest !== digest;
  if (changed && !options.dryRun) {
    await getDb().run(
      `INSERT INTO agent_templates (name, digest, source, bundle, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET
         digest = excluded.digest,
         source = excluded.source,
         bundle = excluded.bundle,
         updated_at = excluded.updated_at`,
      name,
      digest,
      source,
      JSON.stringify(bundle),
      new Date().toISOString(),
    );
  }
  return { name, digest, changed, previousDigest: existing?.digest ?? null, dryRun: options.dryRun === true };
}

export async function listStoredTemplates(): Promise<StoredTemplateRow[]> {
  return getDb().all<StoredTemplateRow>('SELECT name, digest, source, updated_at FROM agent_templates ORDER BY name');
}

export async function getStoredTemplate(name: string): Promise<StoredTemplate | undefined> {
  assertTemplateName(name);
  const row = await getDb().get<StoredTemplateRow & { bundle: string }>(
    'SELECT name, digest, source, bundle, updated_at FROM agent_templates WHERE name = ?',
    name,
  );
  if (!row) return undefined;
  return { name: row.name, digest: row.digest, source: row.source, updated_at: row.updated_at, bundle: parseBundle(row.bundle) };
}

export async function deleteStoredTemplate(name: string): Promise<boolean> {
  assertTemplateName(name);
  const result = await getDb().run('DELETE FROM agent_templates WHERE name = ?', name);
  return (result as { changes?: number }).changes !== 0;
}

/** The directory a stored template reads from, materializing it on first use.
 *  Undefined when no row exists — the caller decides what that means. */
export async function resolveStoredTemplateDir(name: string): Promise<string | undefined> {
  const stored = await getStoredTemplate(name);
  if (!stored) return undefined;
  const dir = materializedDir(name, stored.digest);
  if (fs.existsSync(path.join(dir, 'plugin.json'))) return dir;
  return materializeTemplate(name, stored.bundle).dir;
}
