/**
 * Pure, snapshot-testable English text for every fallback-visible chat
 * notice. No side effects, no DB/IO — callers decide where the text goes.
 */
import { TIMEZONE } from '../../config.js';
import type { FallbackClassification, FallbackState } from './db.js';

function reasonLabel(classification: FallbackClassification | null): string {
  switch (classification) {
    case 'quota':
      return 'quota exhausted';
    case 'billing':
      return 'credit exhausted';
    case 'overload':
      return 'service overloaded';
    case 'timeout':
      return 'no response within time limit';
    case 'manual':
      return 'manual request';
    default:
      return 'unknown reason';
  }
}

function formatResetAt(resetAt: string | null): string | null {
  if (!resetAt) return null;
  const d = new Date(resetAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-US', {
    timeZone: TIMEZONE,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Rule: automatic switch to the backup provider. */
export function switchAutoNotice(
  classification: FallbackClassification,
  backupProvider: string,
  resetAt: string | null,
  model?: string | null,
): string {
  const reset = formatResetAt(resetAt);
  const resetPart = reset ? ` Reset expected: ${reset}.` : '';
  const modelPart = model ? ` (${model})` : '';
  return `⚠️ Claude has exhausted its limits (${reasonLabel(classification)}). Switching to ${backupProvider}${modelPart}.${resetPart}`;
}

/** Rule 13: owner-forced switch, never auto-returns. */
export function switchForcedNotice(backupProvider: string, model?: string | null): string {
  const modelPart = model ? ` (${model})` : '';
  return `🔧 Fallback manually forced to ${backupProvider}${modelPart}.`;
}

/** Rule 11: limits hit and no backup configured — message left failed, not silently re-presented. */
export function noBackupNotice(classification: FallbackClassification, resetAt: string | null): string {
  const reset = formatResetAt(resetAt);
  const resetPart = reset ? ` Reset expected: ${reset}.` : '';
  return `⚠️ Claude has exhausted its limits (${reasonLabel(classification)}) and no backup model is available.${resetPart} You can configure a backup by re-running setup.`;
}

/** Successful return to the native provider. */
export function returnNotice(): string {
  return '✅ Returned to Claude.';
}

/** Both fallback and the return probe/backup are stuck — no further auto-retry loop. */
export function doubleFaultNotice(): string {
  return '⚠️ The backup model also did not respond in time. Try again later.';
}

export function commandDeniedNotice(): string {
  return 'Only owner or admin can use /fallback commands.';
}

/** Rule 6: the assistant must declare, not pretend, when running on the backup model. */
export function forwardBriefing(summary: string | null, backupProvider: string, model: string | null): string {
  const modelPart = model ? model : backupProvider;
  const base = [
    `Claude has exhausted its limits — you are now responding via ${backupProvider}.`,
    `Respond normally to any question, including generic questions about who you are.`,
    `Only when explicitly asked what model you are, state: "Current model: ${modelPart} via ${backupProvider}." — do not pretend to be Claude.`,
    `If asked to do something you cannot do (missing tool, missing capability), state it openly rather than trying or pretending.`,
  ].join(' ');
  return summary ? `${base}\n\nSummary of recent conversation:\n${summary}` : base;
}

/** Rule 9: briefing sent to the return-probe attempt; doubles as the return summary on success. */
export function returnBriefing(summary: string | null): string {
  const base = 'Attempting to respond as Claude — checking if limits are available again.';
  return summary ? `${base}\n\nMeanwhile, summary of exchanges on the backup model:\n${summary}` : base;
}

/** Short wake-up nudge for other agent groups restarted alongside a switch/return (not the origin conversation). */
export function shortSwitchBriefing(backupProvider: string, model: string | null): string {
  const modelPart = model ? ` (${model})` : '';
  return `Responding in place of Claude (limits exhausted) via ${backupProvider}${modelPart}. Not Claude — if asked what model I am, I say the truth.`;
}

export function shortReturnBriefing(): string {
  return 'Claude again.';
}

export function statusNotice(state: FallbackState): string {
  if (!state.active) {
    return 'Active model: Claude. Fallback not active.';
  }
  const modeLabel = state.mode === 'forced' ? 'forced' : 'automatic';
  const modelPart = state.backupModel ? ` on ${state.backupModel}` : '';
  const lines = [
    `Active model: ${state.backupProvider}${modelPart} (${modeLabel} fallback).`,
    `Reason: ${reasonLabel(state.classification)}.`,
  ];
  if (state.enteredAt) lines.push(`Since: ${formatResetAt(state.enteredAt) ?? state.enteredAt}.`);
  if (state.mode === 'auto') {
    const nextAttempt = formatResetAt(state.nextRetryAt ?? state.resetAt);
    lines.push(nextAttempt ? `Next return attempt: ${nextAttempt}.` : 'Next return attempt: not yet scheduled.');
  } else {
    lines.push('Manual return only (`/fallback return`).');
  }
  return lines.join('\n');
}
