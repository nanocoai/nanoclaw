/**
 * Template registry — read-only listing + detail over the folder-backed
 * `templates/` engine. The host owns the template format; the governance
 * service reads template policies and catalogs through these via `ncl templates`.
 */
import fs from 'fs';
import path from 'path';

import { TEMPLATES_DIR } from '../config.js';
import { AGENT_CREATE_SPEC_VERSION } from './create-spec-version.js';
import { loadTemplateSnapshot } from './snapshot.js';
import { listStoredTemplates, resolveStoredTemplateDir } from './store.js';

export type TemplateOrigin = 'local' | 'stored';

/** Names of every template folder under `templates/` — the local dev library. */
export function listLocalTemplateNames(): string[] {
  if (!fs.existsSync(TEMPLATES_DIR)) return [];
  return fs
    .readdirSync(TEMPLATES_DIR)
    .filter((name) => {
      try {
        return fs.statSync(path.join(TEMPLATES_DIR, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * Every template the host can stamp from: the stored library and the local
 * folder library, by name. A name in both resolves STORED — a stored template
 * was pushed for THIS deployment (the release's template-library authority, or
 * an operator through `ncl templates put`), and in a governed fleet the
 * governed template is the source of truth for a template's instructions,
 * skills and policy. The folder library is the seed and the developer's
 * override on a checkout, where nothing is stored and it still resolves.
 *
 * This used to resolve LOCAL, on the assumption that "on a deployment the
 * folder library holds nothing a recipe shipped, so the two do not overlap".
 * That assumption is false: nancy-v3 carried `engineering-agent` and
 * `personal-assistant` in both, so every push was silently shadowed by a stale
 * folder copy — the release stored a template the host then declined to serve,
 * and the deploy's own verify caught it as unproven (2026-09-01).
 */
export async function listTemplateNames(): Promise<Array<{ name: string; origin: TemplateOrigin }>> {
  const stored = await listStoredTemplates();
  const storedNames = new Set(stored.map((row) => row.name));
  const out: Array<{ name: string; origin: TemplateOrigin }> = stored.map((row) => ({ name: row.name, origin: 'stored' as const }));
  for (const name of listLocalTemplateNames()) {
    if (!storedNames.has(name)) out.push({ name, origin: 'local' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The directory a named template reads from, whichever library holds it. */
export async function resolveTemplateDir(name: string): Promise<{ dir: string; origin: TemplateOrigin }> {
  // Membership by the same listing `list` uses — not a `plugin.json` probe
  // rooted at TEMPLATES_DIR. The release packager statically resolves joins
  // from packaged roots, collapses the dynamic segment, and then requires
  // `templates/plugin.json` to exist in the release (build 989: "referenced
  // packaged runtime assets are missing"). A missing manifest still fails, in
  // the parser, with the parser's sentence.
  // Stored first: the governed template wins over a folder copy of the same
  // name (see listTemplateNames). A checkout with nothing stored is unaffected.
  const stored = await resolveStoredTemplateDir(name);
  if (stored) return { dir: stored, origin: 'stored' };
  if (listLocalTemplateNames().includes(name)) return { dir: path.join(TEMPLATES_DIR, name), origin: 'local' };
  throw new Error(`template not found: ${name}`);
}

/** Browse-level summary (cheap, parse-error-tolerant) for the dashboard list. */
export interface TemplateSummary {
  name: string;
  origin: TemplateOrigin;
  provider: string | null;
  skills: string[];
  mcpServers: string[];
  /** Which governance categories the template's own policy declares. */
  rulesetKeys: string[];
  instructionsExcerpt: string;
  /** Set when the folder failed to parse (shown rather than thrown). */
  error?: string;
}

export async function templateSummary(name: string, origin?: TemplateOrigin): Promise<TemplateSummary> {
  try {
    const resolved = await resolveTemplateDir(name);
    const tpl = loadTemplateSnapshot(resolved.dir);
    return {
      name,
      origin: resolved.origin,
      provider: null,
      skills: tpl.skills.map((s) => s.name),
      mcpServers: Object.keys(tpl.mcpServers),
      rulesetKeys:
        tpl.templatePolicy && typeof tpl.templatePolicy === 'object' && !Array.isArray(tpl.templatePolicy)
          ? Object.keys(tpl.templatePolicy)
          : [],
      instructionsExcerpt: (tpl.instructions ?? '').slice(0, 280),
    };
  } catch (err) {
    return {
      name,
      origin: origin ?? 'local',
      provider: null,
      skills: [],
      mcpServers: [],
      rulesetKeys: [],
      instructionsExcerpt: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function listTemplates(): Promise<TemplateSummary[]> {
  const names = await listTemplateNames();
  return Promise.all(names.map(({ name, origin }) => templateSummary(name, origin)));
}

/**
 * Full detail for the effective-policy compute + the dashboard detail view.
 * `templatePolicy` is the template's raw `policies/policy.json`; `mcpCatalog`
 * is its Agent Plugins `mcp.json` launch-config map (the allowlist the granted MCP names
 * filter).
 */
export interface TemplateDetail extends TemplateSummary {
  digest: string;
  templatePolicy: unknown;
  mcpCatalog: Record<string, unknown>;
  packagesApt: string[];
  packagesNpm: string[];
  contextExtras: string[];
  instructions: string;
  provisioningCapabilities: {
    agentCreateSpecVersions: number[];
    createSpecStdin: true;
  };
}

export async function templateDetail(name: string): Promise<TemplateDetail> {
  const resolved = await resolveTemplateDir(name);
  const tpl = loadTemplateSnapshot(resolved.dir);
  return {
    name,
    origin: resolved.origin,
    provider: null,
    skills: tpl.skills.map((s) => s.name),
    mcpServers: Object.keys(tpl.mcpServers),
    rulesetKeys:
      tpl.templatePolicy && typeof tpl.templatePolicy === 'object' && !Array.isArray(tpl.templatePolicy)
        ? Object.keys(tpl.templatePolicy)
        : [],
    instructionsExcerpt: (tpl.instructions ?? '').slice(0, 280),
    digest: tpl.digest,
    templatePolicy: tpl.templatePolicy,
    mcpCatalog: tpl.mcpServers,
    packagesApt: tpl.packages.apt,
    packagesNpm: tpl.packages.npm,
    contextExtras: tpl.contextExtras.map((c) => c.name),
    instructions: tpl.instructions ?? '',
    provisioningCapabilities: {
      agentCreateSpecVersions: [AGENT_CREATE_SPEC_VERSION],
      createSpecStdin: true,
    },
  };
}
