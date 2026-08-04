import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// 确保本地服务不走 http_proxy（OneCLI credential proxy 会设 http_proxy，
// 但 Qdrant 等本地服务必须直连）
if (process.env.http_proxy || process.env.HTTP_PROXY) {
  const existing = process.env.NO_PROXY || process.env.no_proxy || '';
  const locals = new Set(
    existing
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  locals.add('localhost');
  locals.add('127.0.0.1');
  locals.add('open.feishu.cn');
  locals.add('open.larksuite.com');
  const merged = [...locals].join(',');
  process.env.NO_PROXY = merged;
  process.env.no_proxy = merged;
}

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'TZ',
  'CHAT_INDEX_ENABLED',
  'QDRANT_URL',
  'CHAT_INDEX_DEBOUNCE_MS',
  'NANOCLAW_PERSONAL_DIR',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths for agent workspace
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const ONECLI_URL =
  process.env.ONECLI_URL || envConfig.ONECLI_URL || 'http://localhost:10254';
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
// 个人资产目录（平台无关个人资产），加进 agent 目录白名单；空串=未配置
export const PERSONAL_DIR =
  process.env.NANOCLAW_PERSONAL_DIR || envConfig.NANOCLAW_PERSONAL_DIR || '';

// --- Chat Index ---
export const CHAT_INDEX_ENABLED =
  (process.env.CHAT_INDEX_ENABLED || envConfig.CHAT_INDEX_ENABLED || '') ===
  'true';
export const QDRANT_URL =
  process.env.QDRANT_URL || envConfig.QDRANT_URL || 'http://localhost:6333';
export const CHAT_INDEX_DEBOUNCE_MS = parseInt(
  process.env.CHAT_INDEX_DEBOUNCE_MS ||
    envConfig.CHAT_INDEX_DEBOUNCE_MS ||
    '5000',
  10,
);
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '28800000',
  10,
); // 8h default — how long to keep agent alive after last result
export const MAX_CONCURRENT_AGENTS = Math.max(
  1,
  parseInt(
    process.env.MAX_CONCURRENT_AGENTS ||
      process.env.MAX_CONCURRENT_CONTAINERS ||
      '20',
    10,
  ) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  const escaped = escapeRegex(trigger.trim());
  // 匹配消息中任意位置的 trigger（开头、中间、结尾均可）
  // @ 本身就是明确的分隔符，不需要前瞻词边界
  return new RegExp(`${escaped}(?=[\\s\\p{P}]|$)`, 'iu');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
