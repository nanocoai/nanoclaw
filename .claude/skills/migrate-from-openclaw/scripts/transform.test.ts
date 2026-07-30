/**
 * Tests for the OpenClaw → NanoClaw v2 transforms.
 *
 * These are the skill's riskiest shipped code: the credential-routing decision
 * (vault vs .env) and the cron → v2 recurrence mapping. They guard the skill's
 * two real integration assumptions about NanoClaw v2:
 *
 *   1. Container-facing credentials go to the OneCLI vault — never threaded
 *      into a container env var. Channel tokens stay in `.env` for the host.
 *   2. Recurring tasks are `messages_in` rows carrying a cron `recurrence`
 *      plus a `process_after` first-run timestamp — the exact shape the host
 *      recurrence sweep consumes (src/modules/scheduling/recurrence.ts).
 *
 * The cron test imports the real `cron-parser` (the same `CronExpressionParser`
 * the recurrence sweep uses) unmocked, so a missing/renamed dependency turns
 * the test red — that's the dependency integration guard.
 */
import { describe, expect, it } from 'vitest';
import { CronExpressionParser } from 'cron-parser';

import {
  approximateIntervalAsCron,
  channelEnvVars,
  classifyCredential,
  mapCronToRecurrence,
  maskCredential,
  resolveSecretInput,
  vaultCreateCommand,
  type OpenClawSchedule,
} from './transform.js';

// The same cron-parser call the host recurrence sweep makes, used as the
// injected `computeNextCron` so the mapping test mirrors production behavior.
function computeNextCron(expr: string, tz?: string): string {
  return CronExpressionParser.parse(expr, { tz: tz ?? 'UTC' }).next().toISOString();
}

describe('resolveSecretInput', () => {
  it('returns a plain literal value', () => {
    const r = resolveSecretInput('123:ABC-token', {});
    expect(r).toEqual({ resolved: '123:ABC-token', source: 'plain' });
  });

  it('resolves a "${ENV}" template from the state-dir .env', () => {
    const r = resolveSecretInput('${TELEGRAM_BOT_TOKEN}', { TELEGRAM_BOT_TOKEN: 'tok-1' });
    expect(r.resolved).toBe('tok-1');
    expect(r.source).toBe('env_template');
  });

  it('resolves a SecretRef {source:"env"} from the process env fallback', () => {
    const r = resolveSecretInput({ source: 'env', id: 'X_KEY' }, {}, { X_KEY: 'from-proc' });
    expect(r.resolved).toBe('from-proc');
    expect(r.source).toBe('env_ref');
  });

  it('cannot auto-extract file/exec SecretRefs and explains why', () => {
    const file = resolveSecretInput({ source: 'file', id: '/secrets/tok' }, {});
    expect(file.resolved).toBeNull();
    expect(file.source).toBe('file_ref');
    expect(file.note).toContain('cannot auto-extract');

    const exec = resolveSecretInput({ source: 'exec', id: 'op read ...' }, {});
    expect(exec.resolved).toBeNull();
    expect(exec.source).toBe('exec_ref');
  });

  it('reports missing for empty/absent values', () => {
    expect(resolveSecretInput(undefined, {}).source).toBe('missing');
    expect(resolveSecretInput('', {}).source).toBe('missing');
  });
});

describe('maskCredential', () => {
  it('shows first 4 + ... + last 4 for long values', () => {
    expect(maskCredential('sk-ant-abcdefgh1234')).toBe('sk-a...1234');
  });
  it('fully masks short values', () => {
    expect(maskCredential('short')).toBe('****');
  });
});

describe('classifyCredential — vault vs .env routing', () => {
  it('routes container-facing Anthropic credentials to the OneCLI vault', () => {
    const d = classifyCredential('anthropic');
    expect(d).toEqual({
      destination: 'vault',
      plan: { name: 'Anthropic', type: 'anthropic', hostPattern: 'api.anthropic.com' },
    });
  });

  it('routes container-facing OpenAI credentials to the vault as api_key', () => {
    const d = classifyCredential('openai');
    expect(d?.destination).toBe('vault');
    expect(d?.plan?.type).toBe('api_key');
    expect(d?.plan?.hostPattern).toBe('api.openai.com');
  });

  it('keeps host-side channel tokens in .env, never the vault', () => {
    expect(classifyCredential('telegram')).toEqual({
      destination: 'env',
      envVar: 'TELEGRAM_BOT_TOKEN',
    });
    expect(classifyCredential('discord')).toEqual({
      destination: 'env',
      envVar: 'DISCORD_BOT_TOKEN',
    });
  });

  it('selects the right env var for multi-token channels (Slack bot + app)', () => {
    expect(classifyCredential('slack', 0)?.envVar).toBe('SLACK_BOT_TOKEN');
    expect(classifyCredential('slack', 1)?.envVar).toBe('SLACK_APP_TOKEN');
  });

  it('exposes the full channel env-var list', () => {
    expect(channelEnvVars('slack')).toEqual(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    expect(channelEnvVars('telegram')).toEqual(['TELEGRAM_BOT_TOKEN']);
    expect(channelEnvVars('whatsapp')).toEqual([]);
  });

  it('returns null for unknown credential kinds', () => {
    expect(classifyCredential('nonexistent')).toBeNull();
  });
});

describe('vaultCreateCommand', () => {
  it('renders the onecli secrets create command for a vault plan', () => {
    const plan = { name: 'Anthropic', type: 'anthropic' as const, hostPattern: 'api.anthropic.com' };
    expect(vaultCreateCommand(plan, 'sk-ant-xyz')).toBe(
      'onecli secrets create --name Anthropic --type anthropic --value sk-ant-xyz --host-pattern api.anthropic.com',
    );
  });
});

describe('mapCronToRecurrence — v2 task shape', () => {
  it('maps a cron schedule to recurrence=expr + next-fire processAfter', () => {
    const schedule: OpenClawSchedule = { kind: 'cron', expr: '0 9 * * 1-5', tz: 'UTC' };
    const r = mapCronToRecurrence(schedule, { computeNextCron });
    expect(r.recurrence).toBe('0 9 * * 1-5');
    // processAfter must be the next 09:00 UTC the real cron-parser computes.
    expect(r.processAfter).toBe(computeNextCron('0 9 * * 1-5', 'UTC'));
    expect(r.notes).toEqual([]);
  });

  it('maps an "at" schedule to a one-shot task (null recurrence)', () => {
    const at = '2030-01-01T12:00:00.000Z';
    const r = mapCronToRecurrence({ kind: 'at', at }, { computeNextCron });
    expect(r.processAfter).toBe(at);
    expect(r.recurrence).toBeNull();
  });

  it('approximates a clean fixed interval as cron and flags it', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    const r = mapCronToRecurrence({ kind: 'every', everyMs: 15 * 60 * 1000 }, { computeNextCron, now });
    expect(r.recurrence).toBe('*/15 * * * *');
    expect(r.processAfter).toBe('2026-01-01T00:15:00.000Z');
    expect(r.notes[0]).toContain('approximated as cron');
  });

  it('leaves a non-divisible interval one-shot and flags it for the user', () => {
    const r = mapCronToRecurrence({ kind: 'every', everyMs: 90 * 1000 }, { computeNextCron });
    expect(r.recurrence).toBeNull();
    expect(r.notes[0]).toContain('no clean cron equivalent');
  });
});

describe('approximateIntervalAsCron', () => {
  it('maps minute intervals that divide 60', () => {
    expect(approximateIntervalAsCron(5 * 60000)).toBe('*/5 * * * *');
    expect(approximateIntervalAsCron(30 * 60000)).toBe('*/30 * * * *');
  });
  it('maps hour intervals that divide 24', () => {
    expect(approximateIntervalAsCron(60 * 60000)).toBe('0 */1 * * *');
    expect(approximateIntervalAsCron(6 * 60 * 60000)).toBe('0 */6 * * *');
  });
  it('maps daily to midnight', () => {
    expect(approximateIntervalAsCron(24 * 60 * 60000)).toBe('0 0 * * *');
  });
  it('returns null for intervals with no clean cron form', () => {
    expect(approximateIntervalAsCron(90 * 1000)).toBeNull(); // 90s
    expect(approximateIntervalAsCron(7 * 60 * 60000)).toBeNull(); // 7h
    expect(approximateIntervalAsCron(0)).toBeNull();
  });
});
