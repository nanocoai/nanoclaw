/**
 * Parser/reader/writer for the advanced-config registry (setup-config.ts).
 *
 *   readFromEnv()  → values found in process.env
 *   parseFlags()   → values from argv, plus --help and any pass-through args
 *   applyToEnv()   → write resolved values back to process.env so existing
 *                    step code keeps reading env vars unchanged
 *   printHelp()    → render --help from the registry
 *
 * Flag parsing supports:
 *   --key value      space form
 *   --key=value      equals form
 *   --key            booleans only (sets true)
 *   --no-key         booleans only (sets false)
 */
import {
  CONFIG,
  envVarFor,
  flagFor,
  findByFlag,
  type Entry,
} from './setup-config.js';

export type ConfigValues = Record<string, string | boolean | number>;

function coerce(e: Entry, raw: string): string | number | boolean | undefined {
  switch (e.type) {
    case 'boolean': {
      const v = raw.toLowerCase();
      if (['true', '1', 'yes'].includes(v)) return true;
      if (['false', '0', 'no'].includes(v)) return false;
      return undefined;
    }
    case 'integer': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    default:
      return raw;
  }
}

export function readFromEnv(env: NodeJS.ProcessEnv = process.env): ConfigValues {
  const out: ConfigValues = {};
  for (const e of CONFIG) {
    const raw = env[envVarFor(e)];
    if (raw === undefined || raw === '') continue;
    const v = coerce(e, raw);
    if (v !== undefined) out[e.key] = v;
  }
  return out;
}

export type FlagParseResult = {
  values: ConfigValues;
  rest: string[];
  help: boolean;
  errors: string[];
};

export function parseFlags(argv: string[]): FlagParseResult {
  const values: ConfigValues = {};
  const rest: string[] = [];
  const errors: string[] = [];
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    // POSIX end-of-options. pnpm passes a bare `--` through when invoked as
    // `pnpm run script --` with nothing after it; treat the rest as
    // pass-through positional args.
    if (arg === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      rest.push(arg);
      continue;
    }

    const eq = arg.indexOf('=');
    let name = eq === -1 ? arg : arg.slice(0, eq);
    const inline: string | undefined = eq === -1 ? undefined : arg.slice(eq + 1);

    let negated = false;
    if (name.startsWith('--no-')) {
      negated = true;
      name = `--${name.slice(5)}`;
    }

    const entry = findByFlag(name);
    if (!entry) {
      errors.push(`Unknown flag: ${arg}`);
      continue;
    }

    if (entry.type === 'boolean') {
      if (negated) values[entry.key] = false;
      else if (inline !== undefined) {
        const v = coerce(entry, inline);
        if (v === undefined) errors.push(`Invalid boolean for ${name}: ${inline}`);
        else values[entry.key] = v;
      } else values[entry.key] = true;
      continue;
    }

    const raw = inline !== undefined ? inline : argv[++i];
    if (raw === undefined) {
      errors.push(`Missing value for ${name}`);
      continue;
    }
    const v = coerce(entry, raw);
    if (v === undefined) {
      errors.push(`Invalid ${entry.type} for ${name}: ${raw}`);
      continue;
    }
    if (entry.type === 'string' || entry.type === 'url') {
      const err = entry.validate?.(raw);
      if (err) {
        errors.push(`${name}: ${err}`);
        continue;
      }
    }
    values[entry.key] = v;
  }

  return { values, rest, help, errors };
}

export function applyToEnv(
  values: ConfigValues,
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const e of CONFIG) {
    if (!(e.key in values)) continue;
    const v = values[e.key];
    env[envVarFor(e)] =
      typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
  }
}

export function printHelp(stream: NodeJS.WritableStream = process.stdout): void {
  const lines: string[] = [];
  lines.push('Usage: bash nanoclaw.sh [flags...]');
  lines.push('');
  lines.push('Flags:');
  const width = Math.max(
    ...CONFIG.map((e) => flagFor(e).length),
    '--reconfigure-cli'.length,
  );
  for (const e of CONFIG) {
    const flag = flagFor(e).padEnd(width + 2);
    lines.push(`  ${flag}${e.help}`);
  }
  lines.push(
    `  ${'--reconfigure-cli'.padEnd(width + 2)}re-prompt for the setup-helper CLI (Claude Code or Codex) and exit`,
  );
  lines.push('');
  lines.push('Each flag also reads from its corresponding NANOCLAW_<KEY> env var.');
  lines.push('Run without flags for the default interactive flow.');
  stream.write(lines.join('\n') + '\n');
}
