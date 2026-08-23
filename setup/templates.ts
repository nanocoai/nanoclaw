/** Setup-only discovery for the fixed NanoClaw template registry. */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveLocalTemplate } from '../src/templates/local-dir.js';
import { groupsCarryingPlugin } from '../src/templates/restamp.js';
import type { AgentGroup } from '../src/types.js';
import { upsertEnvVar } from './set-env.js';

export const DEFAULT_TEMPLATES_SOURCE = 'https://github.com/nanocoai/nanoclaw-templates';

// The template pick lives in process.env for this run AND in .env for the
// next: the wizard can re-exec itself (`sg docker`, fail-retry) before the
// selected operation runs. Every completed operation clears the pick; setup
// derives later connect/update choices from ncl instead of persisting an agent
// id that could accidentally target a future setup run.
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
  | { status: 'cancelled' };

export type TemplateOperation = { kind: 'create' } | { kind: 'restamp'; agentGroupId: string };

export type SetupTemplateAgent = AgentGroup & { isWired: boolean };

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
  operation: TemplateOperation;
  /** Explicit operator name. Omit to let the CLI fall back to the template's own agentName. */
  name?: string;
  timezone?: string;
  provider?: string;
  runNcl: RunNcl;
  confirmReplace: (plan: TemplateReplacePlan) => Promise<boolean>;
}

/** Resolve template agents and their wiring state through canonical ncl data. */
export async function listTemplateAgents(ref: string, runNcl: RunNcl): Promise<SetupTemplateAgent[]> {
  const groupRows = await runNcl('groups-list', { limit: Number.MAX_SAFE_INTEGER });
  if (!Array.isArray(groupRows)) throw new Error('ncl returned an invalid agent group list');
  const wiringRows = await runNcl('wirings-list', { limit: Number.MAX_SAFE_INTEGER });
  if (!Array.isArray(wiringRows)) throw new Error('ncl returned an invalid wiring list');

  const wiredAgentIds = new Set(wiringRows.map(parseWiringAgentGroupId));
  const groups = await groupsCarryingPlugin(ref, groupRows.map(parseAgentGroup));
  return groups.map((group) => ({ ...group, isWired: wiredAgentIds.has(group.id) }));
}

/** Validation used only after the operator chooses "Create another agent". */
export function validateNewTemplateAgentName(
  value: string | undefined,
  agents: readonly AgentGroup[],
): string | undefined {
  const name = (value ?? '').trim();
  if (!name) return 'Required';
  if (agents.some((agent) => agent.name.toLowerCase() === name.toLowerCase())) {
    return 'Choose a different name so you can tell these agents apart';
  }
  return undefined;
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
  const rels = (fs.readdirSync(dir, { recursive: true }) as string[]).map((entry) => entry.split(path.sep).join('/'));

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
 * setup. The caller supplies an explicit create or targeted-restamp operation;
 * the CLI remains the sole owner of applying it. Restamps dry-run first, apply
 * only after confirmation, and restart so skill/MCP changes take effect.
 */
export async function installTemplateAgent(options: TemplateAgentInstallOptions): Promise<TemplateAgentInstallResult> {
  if (options.operation.kind === 'create') {
    const created = await options.runNcl('groups-create', {
      template: options.ref,
      new: true,
      ...(options.name ? { name: options.name } : {}),
      ...(options.timezone ? { timezone: options.timezone } : {}),
    });
    if (parseReplacePlan(created)) throw new Error('ncl returned an update plan for a new template agent');
    const group = parseAgentGroup(created);
    if (options.provider) {
      await options.runNcl('groups-config-update', { id: group.id, provider: options.provider });
    }
    return { status: 'installed', group };
  }

  const first = await options.runNcl('groups-create', {
    template: options.ref,
    id: options.operation.agentGroupId,
  });
  const plan = parseReplacePlan(first);
  if (!plan || plan.group.id !== options.operation.agentGroupId) {
    throw new Error('ncl did not return the requested template update plan');
  }
  if (!(await options.confirmReplace(plan))) return { status: 'cancelled' };

  const applied = parseReplacePlan(
    await options.runNcl('groups-create', { template: options.ref, id: plan.group.id, yes: true }),
  );
  if (!applied?.applied) throw new Error('ncl did not apply the template update');
  await options.runNcl('groups-restart', { id: applied.group.id });

  return { status: 'updated', group: applied.group };
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

function parseWiringAgentGroupId(value: unknown): string {
  if (!isRecord(value) || typeof value.agent_group_id !== 'string') {
    throw new Error('ncl returned an invalid wiring');
  }
  return value.agent_group_id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
