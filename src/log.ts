import {
  isRedactionPlaceholder,
  isSecretName,
  maskSecretValue,
  redactSecrets,
  SECRET_MASK,
} from './secret-redaction.js';

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
type Level = keyof typeof LEVELS;

const COLORS: Record<Level, string> = {
  debug: '\x1b[34m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[41m\x1b[37m',
};
const KEY_COLOR = '\x1b[35m';
const MSG_COLOR = '\x1b[36m';
const RESET = '\x1b[39m';
const FULL_RESET = '\x1b[0m';

const threshold = LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;

function safeStringify(v: unknown): string {
  // The replacer runs after each toJSON, so nested redaction holds; mapping BigInt
  // and cycles here keeps stringify from throwing on them.
  const ancestors: unknown[] = [];
  /* eslint-disable no-catch-all/no-catch-all -- logging must never throw */
  try {
    return JSON.stringify(v, function (this: unknown, key, value: unknown) {
      if (typeof value === 'bigint') return `${value}n`;
      if (isSecretName(key) && isMaskable(value)) return maskField(value);
      if (typeof value !== 'object' || value === null) return value;
      while (ancestors.length && ancestors[ancestors.length - 1] !== this) ancestors.pop();
      if (ancestors.includes(value)) return '[Circular]';
      ancestors.push(value);
      return value;
    });
  } catch {
    // A throwing toJSON, getter or Proxy trap: fail closed, never print the raw value.
    return '[unserializable]';
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

/** Strings and objects under a secret-named key; a value that is already a placeholder stays. */
function isMaskable(value: unknown): boolean {
  if (typeof value === 'string') return value !== '' && !isRedactionPlaceholder(value);
  return typeof value === 'object' && value !== null;
}

function maskField(value: unknown): string {
  return typeof value === 'string' ? maskSecretValue(value) : SECRET_MASK;
}

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return `{ type: "${err.constructor.name}", message: "${err.message}", stack: ${err.stack} }`;
  }
  return safeStringify(err);
}

function formatData(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    const value = isSecretName(k) && isMaskable(v) ? maskField(v) : k === 'err' ? formatErr(v) : safeStringify(v);
    parts.push(`${KEY_COLOR}${k}${RESET}=${redactSecrets(value)}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function ts(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const tag = `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  /* eslint-disable no-catch-all/no-catch-all -- logging must never throw: a throw here reaches uncaughtException, which exits the host */
  try {
    stream.write(`[${ts()}] ${tag} ${MSG_COLOR}${redactSecrets(msg)}${RESET}${data ? formatData(data) : ''}\n`);
  } catch {
    // e.g. a throwing getter on the data bag itself, read before safeStringify sees it.
    try {
      process.stderr.write(`[${ts()}] ${tag} ${MSG_COLOR}${redactSecrets(msg)}${RESET} [log data unserializable]\n`);
    } catch {
      /* nowhere left to report it */
    }
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => emit('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => emit('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit('error', msg, data),
  fatal: (msg: string, data?: Record<string, unknown>) => emit('fatal', msg, data),
};

process.on('uncaughtException', (err) => {
  log.fatal('Uncaught exception', { err });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection', { err: reason });
});
