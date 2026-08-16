/** Setup-only discovery for the fixed NanoClaw template registry. */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveLocalTemplate } from '../src/templates/local-dir.js';
import type { AgentGroup } from '../src/types.js';
import { upsertEnvVar } from './set-env.js';

export const DEFAULT_TEMPLATES_SOURCE = 'https://github.com/nanocoai/nanoclaw-templates';

// The template pick lives in process.env for this run AND in .env for the
// next: the wizard re-execs itself (`sg docker`, fail-retry) and a rerun over
// a partial install must not lose the choice. It deliberately survives stamp
// success, channel skip, and any failure — only the wire that consumes the
// stamped agent (run-channel-skill), the operator declining it, or an invalid
// preset clears it. The agent group id itself is never persisted: each run
// re-derives it from the pick (`groups create --template` resolves the
// existing group through its plugin carrier — groupsCarryingPlugin — instead
// of creating a duplicate), so a stale id can never override a fresh choice.
export function applyTemplatePick(ref: string): void {
  process.env.NANOCLAW_TEMPLATE_PATH = ref;
  upsertEnvVar('NANOCLAW_TEMPLATE_PATH', ref);
}

export function clearTemplatePick(): void {
  delete process.env.NANOCLAW_TEMPLATE_PATH;
  upsertEnvVar('NANOCLAW_TEMPLATE_PATH', '');
}

export interface TemplateEntry {
  ref: string;
  name: string;
}

export interface ClonedRegistry {
  dir: string;
  cleanup: () => void;
}

type RunNcl = (command: string, args: Record<string, unknown>) => Promise<unknown>;

export type TemplateAgentInstallResult =
  | { status: 'installed'; group: AgentGroup }
  | { status: 'updated'; group: AgentGroup }
  /** Update plan declined: the stamped group is untouched but still usable. */
  | { status: 'kept'; group: AgentGroup };

/** One plugin-owned surface from the dry-run update plan `groups create --template` returns. */
export interface TemplateChange {
  surface: string;
  name: string;
  action: string;
  customized?: boolean;
}

/** The dry-run plan returned when a group already carries the template's plugin. */
export interface TemplateReplacePlan {
  group: AgentGroup;
  changes: TemplateChange[];
  note: string;
}

export interface TemplateAgentInstallOptions {
  ref: string;
  /** Explicit operator name. Omit to let the CLI fall back to the template's own agentName. */
  name?: string;
  timezone?: string;
  provider?: string;
  runNcl: RunNcl;
  confirmReplace: (plan: TemplateReplacePlan) => Promise<boolean>;
}

// A directory is a template iff it is an Agent Plugins directory — the
// manifest is the discovery marker. The pre-plugin layout is detected only to
// point the operator at a re-fetch.
const MARKER = 'plugin.json';
const LEGACY_MARKER = 'context/instructions.md';

export function cloneRegistry(): ClonedRegistry {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-tpl-'));
  try {
    execFileSync('git', ['clone', '--depth', '1', '--', DEFAULT_TEMPLATES_SOURCE, dir], {
      stdio: 'pipe',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('Could not clone the template library', { cause: err });
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export function listTemplatesFromDir(dir: string): TemplateEntry[] {
  if (!fs.existsSync(dir)) return [];
  const rootName = path.basename(path.resolve(dir));
  const rels = (fs.readdirSync(dir, { recursive: true }) as string[]).map((entry) =>
    entry.split(path.sep).join('/'),
  );

  const refs = new Set<string>();
  for (const rel of rels) {
    if (rel === MARKER) refs.add('.');
    else if (rel.endsWith(`/${MARKER}`)) refs.add(rel.slice(0, -(MARKER.length + 1)));
  }

  // A context/instructions.md outside any plugin is the pre-plugin template
  // layout. Fail with a pointer instead of silently listing nothing. (The
  // same file INSIDE a plugin — e.g. ai.nanoco.nanoclaw/context/ — is fine.)
  const legacy = rels
    .filter((rel) => rel === LEGACY_MARKER || rel.endsWith(`/${LEGACY_MARKER}`))
    .map((rel) => (rel === LEGACY_MARKER ? '.' : rel.slice(0, -(LEGACY_MARKER.length + 1))))
    .filter((ref) => !isWithinTemplate(ref, refs));
  if (legacy.length > 0) {
    throw new Error(
      `Templates predate the plugin format (no ${MARKER}): ${legacy.join(', ')}. ` +
        'Re-fetch the template library (and update NanoClaw if fetching does not help).',
    );
  }

  return [...refs]
    .map((ref) => ({ ref, name: ref === '.' ? rootName : (ref.split('/').pop() ?? ref) }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
}

/** True when `ref` equals or sits anywhere below a discovered template ref. */
function isWithinTemplate(ref: string, templateRefs: Set<string>): boolean {
  if (templateRefs.has('.')) return true;
  for (let current = ref; ; ) {
    if (templateRefs.has(current)) return true;
    const cut = current.lastIndexOf('/');
    if (cut === -1) return false;
    current = current.slice(0, cut);
  }
}

/** Copy a list-derived registry template into the local template library. */
export function copyTemplate(srcDir: string, ref: string, destDir: string): string {
  if (ref === '.') throw new Error('Cannot copy the registry root as a template');
  const from = resolveLocalTemplate(ref, srcDir);
  const to = path.resolve(destDir, ref);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, filter: (src) => path.basename(src) !== '.git' });
  return to;
}

/**
 * Stamp the setup-selected template through the same ncl command used after
 * setup. `groups create --template` decides what happens: a fresh stamp when
 * no group carries the plugin, or (on a rerun over a partial install) a
 * dry-run update plan for the group that does. The plan goes to
 * `confirmReplace`; on yes, the same command applies it with --yes and the
 * group restarts so skill/MCP changes take effect. In-place updates never
 * touch memory, sessions, wiring, or anything else the plugin does not own.
 */
export async function installTemplateAgent(options: TemplateAgentInstallOptions): Promise<TemplateAgentInstallResult> {
  const first = await options.runNcl('groups-create', {
    template: options.ref,
    ...(options.name ? { name: options.name } : {}),
    ...(options.timezone ? { timezone: options.timezone } : {}),
  });

  let group: AgentGroup;
  const plan = parseReplacePlan(first);
  if (plan) {
    // Declining the reset means "don't touch my edits", not "abandon my
    // agent": the untouched group is returned so the wizard can wire it as-is
    // (provider update and restart are skipped — those are mutations too).
    if (!(await options.confirmReplace(plan))) return { status: 'kept', group: plan.group };
    const applied = parseReplacePlan(
      await options.runNcl('groups-create', { template: options.ref, id: plan.group.id, yes: true }),
    );
    if (!applied?.applied) throw new Error('ncl did not apply the template update');
    group = applied.group;
  } else {
    group = parseAgentGroup(first);
  }

  if (options.provider) {
    await options.runNcl('groups-config-update', { id: group.id, provider: options.provider });
  }
  if (plan) await options.runNcl('groups-restart', { id: group.id });

  return { status: plan ? 'updated' : 'installed', group };
}

/**
 * Recognize the restamp-plan shape among `groups create` results; a fresh
 * create returns the group row itself (no `changes`). Shape errors throw —
 * a half-recognized plan must never be treated as a created group.
 */
function parseReplacePlan(value: unknown): (TemplateReplacePlan & { applied: boolean }) | undefined {
  if (!isRecord(value) || !('changes' in value)) return undefined;
  const { applied, group, changes, note } = value;
  if (typeof applied !== 'boolean' || !Array.isArray(changes) || typeof note !== 'string') {
    throw new Error('ncl returned an invalid template update plan');
  }
  return { applied, group: parseAgentGroup(group), changes: changes.map(parseTemplateChange), note };
}

function parseTemplateChange(value: unknown): TemplateChange {
  if (
    !isRecord(value) ||
    typeof value.surface !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.action !== 'string'
  ) {
    throw new Error('ncl returned an invalid template update plan');
  }
  const { surface, name, action, customized } = value;
  return { surface, name, action, ...(customized === true ? { customized: true } : {}) };
}

function parseAgentGroup(value: unknown): AgentGroup {
  if (!isRecord(value)) throw new Error('ncl returned an invalid agent group');
  const { id, name, folder, agent_provider: provider, created_at: createdAt } = value;
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof folder !== 'string' ||
    // The groups resource projects only id/name/folder/created_at — list rows
    // carry no agent_provider key (the provider's home is container_configs).
    (provider != null && typeof provider !== 'string') ||
    typeof createdAt !== 'string'
  ) {
    throw new Error('ncl returned an invalid agent group');
  }
  return { id, name, folder, agent_provider: provider ?? null, created_at: createdAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
