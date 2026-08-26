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
import { CONFIG, validateEntry, type Entry } from './setup-config.js';
import type { ConfigValues } from './setup-config-parse.js';
import type { SetupDriver } from './setup-driver.js';

const SKIP_SENTINEL = '__leave_unchanged__';
const DONE_SENTINEL = '__done__';
const MASK = '••••••••';

export async function runAdvancedScreen(initial: ConfigValues, driver?: SetupDriver): Promise<ConfigValues> {
  const result: ConfigValues = { ...initial };
  const visible = CONFIG.filter((e) => e.surface === 'flag+ui');

  while (true) {
    const options = [
      ...visible.map((e) => ({
        value: e.key,
        label: e.label,
        hint: hintFor(e, result),
      })),
      { value: DONE_SENTINEL, label: 'Done - continue with setup', hint: undefined },
    ];

    const choice = driver
      ? String(
          await driver.prompt({
            id: 'advanced-setting',
            kind: 'singleChoice',
            message: 'Pick a setting to override',
            choices: options.map(({ value, label, hint }) => ({ id: value, label, hint })),
            default: DONE_SENTINEL,
          }),
        )
      : (ensureAnswer(
          await brightSelect<string>({
            message: 'Pick a setting to override',
            options,
            initialValue: DONE_SENTINEL,
          }),
        ) as string);

    if (choice === DONE_SENTINEL) return result;
    const entry = visible.find((e) => e.key === choice);
    if (entry?.secret && driver?.mode === 'ndjson') {
      driver.error(
        'secret_transport_forbidden',
        'Machine setup does not accept secrets through advanced configuration. Use the structured authentication prompts instead.',
      );
    }
    if (entry) await promptOne(entry, result, driver);
  }
}

function hintFor(e: Entry, values: ConfigValues): string {
  const v = values[e.key];
  if (v === undefined) return 'not set';
  if (e.secret) return MASK;
  return String(v);
}

async function promptOne(e: Entry, values: ConfigValues, driver?: SetupDriver): Promise<void> {
  if (e.type === 'boolean') {
    const init = typeof values[e.key] === 'boolean' ? (values[e.key] as boolean) : (e.default ?? false);
    const ans = driver
      ? await driver.prompt({ id: `advanced-${e.key}`, kind: 'confirm', message: e.label, default: init })
      : ensureAnswer(await p.confirm({ message: e.label, initialValue: init }));
    values[e.key] = ans as boolean;
    return;
  }

  if (e.type === 'enum') {
    const options = [{ value: SKIP_SENTINEL, label: 'Leave unchanged' }, ...e.options];
    const ans = driver
      ? await driver.prompt({
          id: `advanced-${e.key}`,
          kind: 'singleChoice',
          message: e.label,
          choices: options.map(({ value, label }) => ({ id: value, label })),
          default: SKIP_SENTINEL,
        })
      : ensureAnswer(
          await brightSelect<string>({
            message: e.label,
            options,
            initialValue: SKIP_SENTINEL,
          }),
        );
    if (ans !== SKIP_SENTINEL) values[e.key] = ans as string;
    return;
  }

  if (e.type === 'integer') {
    const validate = (value: boolean | string): string | undefined => {
      const s = String(value).trim();
      if (!s) return undefined;
      const n = Number(s);
      if (!Number.isFinite(n)) return 'Must be a number';
      if (e.min !== undefined && n < e.min) return `Must be ≥ ${e.min}`;
      if (e.max !== undefined && n > e.max) return `Must be ≤ ${e.max}`;
      return undefined;
    };
    const ans = driver
      ? await driver.prompt({
          id: `advanced-${e.key}`,
          kind: 'text',
          message: e.label,
          placeholder: e.default !== undefined ? String(e.default) : undefined,
          validateValue: validate,
        })
      : ensureAnswer(
          await p.text({
            message: e.label,
            placeholder: e.default !== undefined ? String(e.default) : undefined,
            validate: (v) => validate(v ?? ''),
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
    return validateEntry(e, s);
  };
  const ans = driver
    ? await driver.prompt({
        id: `advanced-${e.key}`,
        kind: e.secret ? 'secret' : 'text',
        message: e.label,
        sensitive: e.secret,
        placeholder: e.placeholder ?? e.default,
        validateValue: (value) => validate(String(value)),
      })
    : ensureAnswer(
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
