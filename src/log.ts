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
const REDACTED = '[REDACTED]';
const OMITTED = '[OMITTED]';
const TRUNCATED = '[TRUNCATED]';
const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|secret|token|api[_-]?key)/i;
const PAYLOAD_KEY = /^(?:args?|arguments?|body|content|input|payload|progress|result|taskContext)$/i;

const threshold = LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;

function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${REDACTED}`)
    .replace(
      /\b(authorization|cookie|credential|password|secret|token|api[_-]?key)\b(\s*[:=]\s*)(["']?)[^,\s}"']+/gi,
      `$1$2$3${REDACTED}`,
    );
}

function redactValue(value: unknown, key: string, depth: number, seen: WeakSet<object>): unknown {
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  if (PAYLOAD_KEY.test(key)) return OMITTED;
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 5) return TRUNCATED;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (value instanceof Error) {
    return {
      type: value.constructor.name,
      message: redactText(value.message),
      stack: value.stack ? redactText(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, '', depth + 1, seen));
  return Object.fromEntries(
    Object.entries(value).map(([nestedKey, nestedValue]) => [
      nestedKey,
      redactValue(nestedValue, nestedKey, depth + 1, seen),
    ]),
  );
}

export function redactLogData(data: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakSet<object>();
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, redactValue(value, key, 0, seen)]));
}

function formatData(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(redactLogData(data))) {
    parts.push(`${KEY_COLOR}${k}${RESET}=${JSON.stringify(v)}`);
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
  stream.write(`[${ts()}] ${tag} ${MSG_COLOR}${msg}${RESET}${data ? formatData(data) : ''}\n`);
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
