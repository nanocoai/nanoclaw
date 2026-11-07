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

// Own fields printed with an Error. An allowlist: SDK errors can carry request
// config and headers, and a log must never receive a credential.
const ERROR_FIELDS = [
  'code',
  'errno',
  'syscall',
  'address',
  'port',
  'hostname',
  'path',
  'signal',
  'status',
  'statusCode',
];
const SECRET_KEY = /token|secret|password|authorization|cookie|api[-_]?key|credential/i;
const MAX_CAUSE_DEPTH = 5;

function redact(value: unknown, depth = 0): unknown {
  if (typeof value !== 'object' || value === null || depth > MAX_CAUSE_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1)]),
  );
}

function errorFields(err: Error): Record<string, unknown> | undefined {
  const fields = Object.fromEntries(
    ERROR_FIELDS.filter((key) => Object.prototype.hasOwnProperty.call(err, key)).map((key) => [
      key,
      redact((err as unknown as Record<string, unknown>)[key]),
    ]),
  );
  return Object.keys(fields).length > 0 ? fields : undefined;
}

// JSON.stringify(new Error('x')) is `{}`: give every Error, at any key or depth,
// its message, stack, allowlisted fields and causes.
function serializeError(err: Error, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = { type: err.constructor.name, message: err.message };
  const fields = errorFields(err);
  if (fields) out.fields = fields;
  if (err.stack) out.stack = err.stack;
  if (depth < MAX_CAUSE_DEPTH) {
    if (err.cause !== undefined)
      out.cause = err.cause instanceof Error ? serializeError(err.cause, depth + 1) : err.cause;
    if (err instanceof AggregateError) {
      out.errors = err.errors.map((e: unknown) => (e instanceof Error ? serializeError(e, depth + 1) : e));
    }
  }
  return out;
}

function safeStringify(v: unknown): string {
  // The replacer runs after each toJSON, so nested redaction holds; mapping BigInt
  // and cycles here keeps stringify from throwing on them.
  const ancestors: unknown[] = [];
  /* eslint-disable no-catch-all/no-catch-all -- logging must never throw */
  try {
    return JSON.stringify(v, function (this: unknown, _key, value: unknown) {
      if (typeof value === 'bigint') return `${value}n`;
      if (value instanceof Error) return serializeError(value);
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

// `err` keeps its one-line shape; each cause and AggregateError member follows
// on its own line.
function formatErr(err: unknown, depth = 0): string {
  if (!(err instanceof Error)) return safeStringify(err);
  const fields = errorFields(err);
  const lines = [
    `{ type: "${err.constructor.name}", message: "${err.message}",${fields ? ` fields: ${safeStringify(fields)},` : ''} stack: ${err.stack} }`,
  ];
  if (depth < MAX_CAUSE_DEPTH) {
    if (err instanceof AggregateError) {
      err.errors.forEach((inner: unknown, i: number) => lines.push(`error[${i}]: ${formatErr(inner, depth + 1)}`));
    }
    if (err.cause !== undefined) lines.push(`caused by: ${formatErr(err.cause, depth + 1)}`);
  }
  return lines.join('\n');
}

function formatData(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    parts.push(`${KEY_COLOR}${k}${RESET}=${k === 'err' ? formatErr(v) : safeStringify(v)}`);
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
    stream.write(`[${ts()}] ${tag} ${MSG_COLOR}${msg}${RESET}${data ? formatData(data) : ''}\n`);
  } catch {
    // e.g. a throwing getter on the data bag itself, read before safeStringify sees it.
    try {
      process.stderr.write(`[${ts()}] ${tag} ${MSG_COLOR}${msg}${RESET} [log data unserializable]\n`);
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
