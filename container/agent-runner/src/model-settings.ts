import fs from 'fs';
import path from 'path';

/** SDK 模式 effort（Claude Code 原生三档） */
export type SdkEffortLevel = 'low' | 'medium' | 'high';
/** Codex 模式 effort（5 档，对应 Codex CLI model_reasoning_effort） */
export type CodexEffortLevel = 'light' | 'medium' | 'high' | 'extra_high' | 'ultra';
/** Codex 服务档位：standard 为默认，fast 为官方快速模式 */
export type CodexServiceTier = 'standard' | 'fast';
export type EffortLevel = SdkEffortLevel | CodexEffortLevel;

export interface GroupModelSettings {
  model?: string;
  effortLevel?: EffortLevel;
  serviceTier?: CodexServiceTier;
}

/** settings.json 磁盘结构：claude/codex 各自独立命名空间 */
interface SettingsFile {
  /** 旧格式兼容（扁平 model/effortLevel） */
  model?: unknown;
  effortLevel?: unknown;
  /** Claude SDK 模式配置 */
  claude?: { model?: unknown; effortLevel?: unknown };
  /** Codex CLI 模式配置 */
  codex?: { model?: unknown; effortLevel?: unknown; serviceTier?: unknown };
}

export function normalizeClaudeModelName(model: unknown): string | undefined {
  if (typeof model !== 'string') return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

function resolveSettingsPath(input: { groupPath: string; groupFolder: string }): string {
  return path.join(
    input.groupPath,
    '..',
    '..',
    'data',
    'sessions',
    input.groupFolder,
    '.claude',
    'settings.json',
  );
}

function readSettingsFile(settingsPath: string): SettingsFile | null {
  try {
    if (!fs.existsSync(settingsPath)) return null;
    return JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as SettingsFile;
  } catch {
    return null;
  }
}

/**
 * 读取群级 Claude SDK 模式配置。
 * 优先读 settings.claude 命名空间，兼容旧格式顶层字段。
 */
export function readGroupModelSettings(input: {
  groupPath: string;
  groupFolder: string;
}): GroupModelSettings {
  const settings = readSettingsFile(resolveSettingsPath(input));
  if (!settings) return {};

  const ns = settings.claude;
  const rawModel = ns?.model ?? settings.model;
  const rawEffort = ns?.effortLevel ?? settings.effortLevel;

  const result: GroupModelSettings = {};
  const model = normalizeClaudeModelName(rawModel);
  if (model) result.model = model;

  const validEfforts: SdkEffortLevel[] = ['low', 'medium', 'high'];
  if (validEfforts.includes(rawEffort as SdkEffortLevel)) {
    result.effortLevel = rawEffort as SdkEffortLevel;
  }
  return result;
}

/**
 * 读取群级 Codex CLI 模式配置。
 * 只读 settings.codex 命名空间，不 fallback 到顶层扁平字段
 * （顶层存的是 Claude 配置，model 名如 claude-opus-4-8 喂给 Codex 会炸）。
 */
export function readCodexModelSettings(input: {
  groupPath: string;
  groupFolder: string;
}): GroupModelSettings {
  const settings = readSettingsFile(resolveSettingsPath(input));
  if (!settings) return {};

  const ns = settings.codex;
  if (!ns) return {};

  const result: GroupModelSettings = {};
  const model = normalizeClaudeModelName(ns.model);
  if (model) result.model = model;

  const validEfforts: CodexEffortLevel[] = ['light', 'medium', 'high', 'extra_high', 'ultra'];
  if (validEfforts.includes(ns.effortLevel as CodexEffortLevel)) {
    result.effortLevel = ns.effortLevel as CodexEffortLevel;
  }

  const validServiceTiers: CodexServiceTier[] = ['standard', 'fast'];
  if (validServiceTiers.includes(ns.serviceTier as CodexServiceTier)) {
    result.serviceTier = ns.serviceTier as CodexServiceTier;
  }
  return result;
}
