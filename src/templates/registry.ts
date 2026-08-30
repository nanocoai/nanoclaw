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

/** Names of every template folder under `templates/`. */
export function listTemplateNames(): string[] {
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

/** Browse-level summary (cheap, parse-error-tolerant) for the dashboard list. */
export interface TemplateSummary {
  name: string;
  provider: string | null;
  skills: string[];
  mcpServers: string[];
  /** Which governance categories the template's own policy declares. */
  rulesetKeys: string[];
  instructionsExcerpt: string;
  /** Set when the folder failed to parse (shown rather than thrown). */
  error?: string;
}

export function templateSummary(name: string): TemplateSummary {
  try {
    const tpl = loadTemplateSnapshot(path.join(TEMPLATES_DIR, name));
    return {
      name,
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
      provider: null,
      skills: [],
      mcpServers: [],
      rulesetKeys: [],
      instructionsExcerpt: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function listTemplates(): TemplateSummary[] {
  return listTemplateNames().map(templateSummary);
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

export function templateDetail(name: string): TemplateDetail {
  const tpl = loadTemplateSnapshot(path.join(TEMPLATES_DIR, name));
  return {
    name,
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
