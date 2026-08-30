import path from 'path';

import {
  parseMcpServerConfig,
  validateMcpServerName,
  type McpServerConfig,
} from '../container-config.js';
import { AGENT_CREATE_SPEC_VERSION } from './create-spec-version.js';

export { AGENT_CREATE_SPEC_VERSION };
export const MAX_AGENT_CREATE_SPEC_BYTES = 2 * 1024 * 1024;
export const MAX_TEMPLATE_CONTRIBUTION_FILES = 256;
export const MAX_TEMPLATE_CONTRIBUTION_FILE_BYTES = 128 * 1024;
export const MAX_TEMPLATE_CONTRIBUTION_INSTRUCTIONS = 32;

export interface TemplateContextContribution {
  /** Path relative to the template's context/ directory. */
  name: string;
  content: string;
}

export interface TemplateSkillContribution {
  name: string;
  files: Readonly<Record<string, string>>;
}

export interface TemplateContributions {
  /** Standing instructions appended to ai.nanoco.nanoclaw/context/instructions.md before stamping. */
  standingInstructions?: readonly string[];
  /** Files added under ai.nanoco.nanoclaw/context/ before stamping. */
  contextFiles?: readonly TemplateContextContribution[];
  /** Skills added under skills/ before stamping. */
  skills?: readonly TemplateSkillContribution[];
}

export interface AgentCreateSpec {
  /** Version 2 adds templateContributions and bounded stdin transport. */
  version?: typeof AGENT_CREATE_SPEC_VERSION;
  id: string;
  /** Governance-minted agent id (optional). Validated and adopted verbatim as
   *  the group id before structural validation — see governance-agent-id.ts.
   *  When present, `id` may be omitted (or must be identical). */
  agentId?: string;
  name: string;
  folder: string;
  template: {
    ref: string;
    expectedDigest: string;
    source?: string;
  };
  config: {
    mcpServers: Record<string, McpServerConfig>;
    cliScope: 'disabled' | 'group' | 'global';
    assistantName?: string | null;
    packagesApt: string[];
    packagesNpm: string[];
  };
  provisionedUserId?: string | null;
  templateContributions?: TemplateContributions;
}

/**
 * Parse a raw `--spec` JSON payload into an AgentCreateSpec, rewrapping parse
 * failures in a CLI-shaped error. Structural validation happens later, in
 * `validateAgentCreateSpec` (called by `createAgentFromSpec`).
 */
export function parseAgentCreateSpecJson(raw: string): AgentCreateSpec {
  try {
    return JSON.parse(raw) as AgentCreateSpec;
  } catch (err) {
    throw new Error(`--spec must be valid JSON: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
}

export function validateAgentCreateSpec(spec: AgentCreateSpec): void {
  if (!spec || typeof spec !== 'object') throw new Error('--spec must be a JSON object');
  const payloadBytes = byteLength(JSON.stringify(spec));
  if (payloadBytes > MAX_AGENT_CREATE_SPEC_BYTES) {
    throw new Error(`--spec exceeds ${MAX_AGENT_CREATE_SPEC_BYTES} bytes (got ${payloadBytes})`);
  }
  if (spec.version !== undefined && spec.version !== AGENT_CREATE_SPEC_VERSION) {
    throw new Error(`unsupported agent create spec version: ${String(spec.version)}`);
  }
  if (spec.templateContributions !== undefined && spec.version !== AGENT_CREATE_SPEC_VERSION) {
    throw new Error(`--spec.templateContributions requires version ${AGENT_CREATE_SPEC_VERSION}`);
  }
  if (
    typeof spec.id !== 'string' ||
    !spec.id ||
    typeof spec.name !== 'string' ||
    !spec.name ||
    typeof spec.folder !== 'string' ||
    !spec.folder
  ) {
    throw new Error('--spec requires string id, name, and folder');
  }
  if (
    !spec.template ||
    typeof spec.template !== 'object' ||
    typeof spec.template.ref !== 'string' ||
    !spec.template.ref ||
    typeof spec.template.expectedDigest !== 'string' ||
    !spec.template.expectedDigest
  ) {
    throw new Error('--spec.template requires ref and expectedDigest');
  }
  if (spec.template.source !== undefined && typeof spec.template.source !== 'string') {
    throw new Error('--spec.template.source must be a string');
  }
  if (!spec.config || typeof spec.config !== 'object') throw new Error('--spec.config is required');
  if (!['disabled', 'group', 'global'].includes(spec.config.cliScope)) {
    throw new Error('--spec.config.cliScope must be disabled, group, or global');
  }
  validateMcpServers(spec.config.mcpServers);
  if (
    spec.config.assistantName !== undefined &&
    spec.config.assistantName !== null &&
    typeof spec.config.assistantName !== 'string'
  ) {
    throw new Error('--spec.config.assistantName must be a string or null');
  }
  if (!Array.isArray(spec.config.packagesApt) || !spec.config.packagesApt.every((v) => typeof v === 'string')) {
    throw new Error('--spec.config.packagesApt must be an array of strings');
  }
  if (!Array.isArray(spec.config.packagesNpm) || !spec.config.packagesNpm.every((v) => typeof v === 'string')) {
    throw new Error('--spec.config.packagesNpm must be an array of strings');
  }
  validatePackageList(spec.config.packagesApt, '--spec.config.packagesApt');
  validatePackageList(spec.config.packagesNpm, '--spec.config.packagesNpm');
  if (
    spec.provisionedUserId !== undefined &&
    spec.provisionedUserId !== null &&
    typeof spec.provisionedUserId !== 'string'
  ) {
    throw new Error('--spec.provisionedUserId must be a string or null');
  }
  validateTemplateContributions(spec.templateContributions);
}

function validatePackageList(values: readonly string[], label: string): void {
  for (const [index, value] of values.entries()) {
    if (!value || value !== value.trim() || value.includes('\n') || value.includes('\r') || value.startsWith('#')) {
      throw new Error(`${label}[${index}] must be a nonempty single-line package name`);
    }
  }
}

function validateMcpServers(value: AgentCreateSpec['config']['mcpServers']): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('--spec.config.mcpServers must be an object');
  }
  for (const [name, candidate] of Object.entries(value)) {
    if (!name || !candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`--spec.config.mcpServers.${name || '<empty>'} must be an object`);
    }
    try {
      validateMcpServerName(name);
      const server = candidate as unknown as Record<string, unknown>;
      if (server.plugin !== undefined || server.pluginRoot !== undefined || server.instructions !== undefined) {
        throw new Error('must contain launch configuration only, without internal ownership or instruction fields');
      }
      parseMcpServerConfig(server);
    } catch (err) {
      throw new Error(
        `--spec.config.mcpServers.${name}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
}

function validateTemplateContributions(contributions: TemplateContributions | undefined): void {
  if (contributions === undefined) return;
  if (!contributions || typeof contributions !== 'object' || Array.isArray(contributions)) {
    throw new Error('--spec.templateContributions must be an object');
  }

  const instructions = contributions.standingInstructions ?? [];
  if (
    !Array.isArray(instructions) ||
    instructions.length > MAX_TEMPLATE_CONTRIBUTION_INSTRUCTIONS ||
    !instructions.every((value) => typeof value === 'string')
  ) {
    throw new Error(
      `--spec.templateContributions.standingInstructions must contain at most ${MAX_TEMPLATE_CONTRIBUTION_INSTRUCTIONS} strings`,
    );
  }
  for (const [index, instruction] of instructions.entries()) {
    validateContributionBytes(instruction, `template contribution instruction ${index}`);
  }

  const contextFiles = contributions.contextFiles ?? [];
  if (!Array.isArray(contextFiles)) {
    throw new Error('--spec.templateContributions.contextFiles must be an array');
  }
  const skills = contributions.skills ?? [];
  if (!Array.isArray(skills)) {
    throw new Error('--spec.templateContributions.skills must be an array');
  }

  let fileCount = contextFiles.length;
  for (const [index, file] of contextFiles.entries()) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw new Error(`--spec.templateContributions.contextFiles[${index}] must be an object`);
    }
    if (typeof file.name !== 'string' || typeof file.content !== 'string') {
      throw new Error(`--spec.templateContributions.contextFiles[${index}] requires string name and content`);
    }
    validateRelativePath(file.name, 'template context file');
    if (!file.name.endsWith('.md')) {
      throw new Error(`template context file must be Markdown: ${file.name}`);
    }
    validateContributionBytes(file.content, `template context file ${file.name}`);
  }

  const skillNames = new Set<string>();
  for (const [index, skill] of skills.entries()) {
    if (!skill || typeof skill !== 'object' || Array.isArray(skill)) {
      throw new Error(`--spec.templateContributions.skills[${index}] must be an object`);
    }
    if (
      typeof skill.name !== 'string' ||
      !skill.files ||
      typeof skill.files !== 'object' ||
      Array.isArray(skill.files)
    ) {
      throw new Error(`--spec.templateContributions.skills[${index}] requires a string name and files object`);
    }
    validateSkillName(skill.name);
    if (skillNames.has(skill.name)) throw new Error(`duplicate template contribution skill: ${skill.name}`);
    skillNames.add(skill.name);

    const files = Object.entries(skill.files);
    if (files.length === 0) throw new Error(`template contribution skill "${skill.name}" has no files`);
    if (typeof skill.files['SKILL.md'] !== 'string') {
      throw new Error(`template contribution skill "${skill.name}" is missing required SKILL.md`);
    }
    fileCount += files.length;
    for (const [file, content] of files) {
      validateRelativePath(file, 'template skill file');
      if (typeof content !== 'string') {
        throw new Error(`template skill file ${skill.name}/${file} must be text`);
      }
      validateContributionBytes(content, `template skill file ${skill.name}/${file}`);
    }
  }
  if (fileCount > MAX_TEMPLATE_CONTRIBUTION_FILES) {
    throw new Error(`--spec.templateContributions exceeds ${MAX_TEMPLATE_CONTRIBUTION_FILES} files`);
  }
}

function validateSkillName(name: string): void {
  if (!name || path.basename(name) !== name || name.includes('\\') || name === '.' || name === '..') {
    throw new Error(`unsafe template contribution skill name: ${JSON.stringify(name)}`);
  }
}

function validateRelativePath(file: string, label: string): void {
  if (
    !file ||
    file.includes('\\') ||
    path.posix.isAbsolute(file) ||
    path.posix.normalize(file) !== file ||
    file === '.' ||
    file.startsWith('../') ||
    file.includes('/../')
  ) {
    throw new Error(`unsafe ${label} path: ${JSON.stringify(file)}`);
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function validateContributionBytes(content: string, label: string): void {
  const bytes = byteLength(content);
  if (bytes > MAX_TEMPLATE_CONTRIBUTION_FILE_BYTES) {
    throw new Error(`${label} exceeds ${MAX_TEMPLATE_CONTRIBUTION_FILE_BYTES} bytes`);
  }
}
