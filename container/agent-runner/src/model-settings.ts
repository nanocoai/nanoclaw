import fs from 'fs';
import path from 'path';

export interface GroupModelSettings {
  model?: string;
  effortLevel?: 'low' | 'medium' | 'high';
}

export function normalizeClaudeModelName(model: unknown): string | undefined {
  if (typeof model !== 'string') return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

export function readGroupModelSettings(input: {
  groupPath: string;
  groupFolder: string;
}): GroupModelSettings {
  const settingsPath = path.join(
    input.groupPath,
    '..',
    '..',
    'data',
    'sessions',
    input.groupFolder,
    '.claude',
    'settings.json',
  );

  try {
    if (!fs.existsSync(settingsPath)) return {};
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      model?: unknown;
      effortLevel?: unknown;
    };
    const result: GroupModelSettings = {};
    const model = normalizeClaudeModelName(settings.model);
    if (model) result.model = model;
    if (
      settings.effortLevel === 'low' ||
      settings.effortLevel === 'medium' ||
      settings.effortLevel === 'high'
    ) {
      result.effortLevel = settings.effortLevel;
    }
    return result;
  } catch {
    return {};
  }
}
