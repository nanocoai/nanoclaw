/**
 * Advanced-settings screen — menu of UI-visible entries from the config
 * registry. The user picks one entry, edits it, returns to the menu, and
 * exits via "Done". Returns a fresh values object; the caller passes it to
 * applyToEnv() so downstream step code reads them via env vars.
 *
 * Per-entry edit contract:
 *   - Blank input on text/password/integer = leave current value unchanged.
 *   - Enums get a synthetic "leave unchanged" first option.
 *   - Booleans use confirm with the current value as initialValue.
 *   - Secret entries mask the current value as bullets in hints/labels.
 */
import * as p from '@clack/prompts';

import { brightSelect } from './bright-select.js';
import { ensureAnswer } from './runner.js';
import { CONFIG, type Entry } from './setup-config.js';
import type { ConfigValues } from './setup-config-parse.js';

const SKIP_SENTINEL = '__leave_unchanged__';
const DONE_SENTINEL = '__done__';
const MASK = '••••••••';

export async function runAdvancedScreen(initial: ConfigValues): Promise<ConfigValues> {
  const result: ConfigValues = { ...initial };
  const visible = CONFIG.filter((e) => e.surface === 'flag+ui');

  while (true) {
    const options = [
      ...visible.map((e) => ({
        value: e.key,
        label: e.label,
        hint: hintFor(e, result),
      })),
      { value: DONE_SENTINEL, label: 'Done — continue with setup' },
    ];

    const choice = ensureAnswer(
      await brightSelect<string>({
        message: 'Pick a setting to override',
        options,
        initialValue: DONE_SENTINEL,
      }),
    ) as string;

    if (choice === DONE_SENTINEL) return result;
    const entry = visible.find((e) => e.key === choice);
    if (entry) await promptOne(entry, result);
  }
}

function hintFor(e: Entry, values: ConfigValues): string {
  const v = values[e.key];
  if (v === undefined) return 'not set';
  if (e.secret) return MASK;
  return String(v);
}

async function promptOne(e: Entry, values: ConfigValues): Promise<void> {
  if (e.type === 'boolean') {
    const init = typeof values[e.key] === 'boolean' ? (values[e.key] as boolean) : (e.default ?? false);
    const ans = ensureAnswer(await p.confirm({ message: e.label, initialValue: init }));
    values[e.key] = ans as boolean;
    return;
  }

  if (e.type === 'enum') {
    const ans = ensureAnswer(
      await brightSelect<string>({
        message: e.label,
        options: [{ value: SKIP_SENTINEL, label: 'Leave unchanged' }, ...e.options],
        initialValue: SKIP_SENTINEL,
      }),
    );
    if (ans !== SKIP_SENTINEL) values[e.key] = ans as string;
    return;
  }

  if (e.type === 'integer') {
    const ans = ensureAnswer(
      await p.text({
        message: e.label,
        placeholder: e.default !== undefined ? String(e.default) : undefined,
        validate: (v) => {
          const s = (v ?? '').trim();
          if (!s) return undefined;
          const n = Number(s);
          if (!Number.isFinite(n)) return 'Must be a number';
          if (e.min !== undefined && n < e.min) return `Must be ≥ ${e.min}`;
          if (e.max !== undefined && n > e.max) return `Must be ≤ ${e.max}`;
          return undefined;
        },
      }),
    );
    const trimmed = ((ans as string) ?? '').trim();
    if (trimmed) values[e.key] = Number(trimmed);
    return;
  }

  // string | url
  const validate = (v: string | undefined): string | undefined => {
    const s = (v ?? '').trim();
    if (!s) return undefined;
    return e.validate?.(s);
  };
  const ans = ensureAnswer(
    e.secret
      ? await p.password({ message: e.label, clearOnError: true, validate })
      : await p.text({
          message: e.label,
          placeholder: e.placeholder ?? e.default,
          validate,
        }),
  );
  const trimmed = ((ans as string) ?? '').trim();
  if (trimmed) values[e.key] = trimmed;
}
