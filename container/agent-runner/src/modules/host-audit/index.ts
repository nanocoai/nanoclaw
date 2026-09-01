/** Container-side structural skill activity producer. Never writes tool arguments or paths. */
import fs from 'fs';

import { writeMessageOut } from '../../db/messages-out.js';

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const pendingSkillCreations = new Map<string, string>();

function isSkillName(value: unknown): value is string {
  return typeof value === 'string' && SKILL_NAME_RE.test(value);
}

function id(): string {
  return `host-audit-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function emitSkillActivity(eventType: 'skill_created' | 'skill_used', skillName: unknown): Promise<void> {
  if (!isSkillName(skillName)) return;
  try {
    await writeMessageOut({
      id: id(),
      kind: 'system',
      content: JSON.stringify({
        action: 'host_audit_activity',
        event_type: eventType,
        activity_id: skillName,
      }),
    });
  } catch (err) {
    console.error(`[host-audit] activity emit failed open: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function emitSkillUsed(toolInput: unknown): Promise<void> {
  await emitSkillActivity('skill_used', skillNameFromUse(toolInput));
}

export function skillNameFromUse(toolInput: unknown): string | null {
  if (typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput)) return null;
  const value = (toolInput as Record<string, unknown>).skill;
  return isSkillName(value) ? value : null;
}

/**
 * A successful Write of a skill's SKILL.md is the creation seam.
 * The full path is inspected locally and discarded; only the bounded skill
 * slug is placed on the outbound structural action.
 */
export function rememberSkillCreationCandidate(toolName: string, toolInput: unknown, toolUseId: unknown): void {
  if (typeof toolUseId !== 'string' || toolUseId.length < 1 || toolUseId.length > 256) return;
  const skillName = skillNameFromCreatedTool(toolName, toolInput);
  if (!skillName || typeof toolInput !== 'object' || toolInput === null) return;
  const filePath = (toolInput as Record<string, unknown>).file_path;
  if (typeof filePath === 'string' && !fs.existsSync(filePath)) pendingSkillCreations.set(toolUseId, skillName);
}

export async function emitSkillCreated(toolUseId: unknown): Promise<void> {
  if (typeof toolUseId !== 'string') return;
  const skillName = pendingSkillCreations.get(toolUseId);
  pendingSkillCreations.delete(toolUseId);
  await emitSkillActivity('skill_created', skillName);
}

export function discardSkillCreationCandidate(toolUseId: unknown): void {
  if (typeof toolUseId === 'string') pendingSkillCreations.delete(toolUseId);
}

export function skillNameFromCreatedTool(toolName: string, toolInput: unknown): string | null {
  if (toolName !== 'Write') return null;
  if (typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput)) return null;
  const filePath = (toolInput as Record<string, unknown>).file_path;
  if (typeof filePath !== 'string') return null;
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/\/(?:\.claude|agent)\/skills\/([^/]+)\/SKILL\.md$/i);
  return isSkillName(match?.[1]) ? match[1] : null;
}
