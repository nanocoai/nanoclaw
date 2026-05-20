import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { getContainerImageBase, getDefaultContainerImage, getInstallSlug } from './install-slug.js';
import { isValidTimezone } from './timezone.js';
import type { SeekDbCentralDbOptions, SeekDbMode } from './db/central/types.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'ONECLI_API_KEY',
  'TZ',
  'NANOCLAW_CENTRAL_DB_BACKEND',
  'SEEKDB_PATH',
  'SEEKDB_HOST',
  'SEEKDB_PORT',
  'SEEKDB_USER',
  'SEEKDB_PASSWORD',
  'SEEKDB_DATABASE',
]);

export type CentralDbBackend = 'sqlite' | 'seekdb';

function resolveCentralDbBackend(): CentralDbBackend {
  const raw = (process.env.NANOCLAW_CENTRAL_DB_BACKEND || envConfig.NANOCLAW_CENTRAL_DB_BACKEND || 'sqlite')
    .trim()
    .toLowerCase();
  if (raw === 'seekdb' || raw === 'mysql') return 'seekdb';
  return 'sqlite';
}

/** Central admin DB backend. Session inbound/outbound DBs always use SQLite files. */
export const CENTRAL_DB_BACKEND = resolveCentralDbBackend();

function seekDbEnvExplicit(key: string): boolean {
  return process.env[key] !== undefined || envConfig[key] !== undefined;
}

/** Server when SEEKDB_HOST or SEEKDB_PORT is set in .env / environment; otherwise embedded. */
function resolveSeekDbMode(): SeekDbMode {
  if (seekDbEnvExplicit('SEEKDB_HOST') || seekDbEnvExplicit('SEEKDB_PORT')) {
    return 'server';
  }
  return 'embedded';
}
export const SEEKDB_HOST = process.env.SEEKDB_HOST || envConfig.SEEKDB_HOST || '127.0.0.1';
export const SEEKDB_PORT = parseInt(process.env.SEEKDB_PORT || envConfig.SEEKDB_PORT || '2881', 10);
export const SEEKDB_USER = process.env.SEEKDB_USER || envConfig.SEEKDB_USER || 'root';
export const SEEKDB_PASSWORD = process.env.SEEKDB_PASSWORD || envConfig.SEEKDB_PASSWORD || '';
export const SEEKDB_DATABASE = process.env.SEEKDB_DATABASE || envConfig.SEEKDB_DATABASE || 'test';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'mount-allowlist.json');
export const SENDER_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'sender-allowlist.json');
export const STORE_DIR = process.env.STORE_DIR
  ? path.resolve(process.env.STORE_DIR)
  : path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
/** SeekDB embedded storage path (project-relative by default: `./seekdb.db`). */
export const SEEKDB_PATH =
  process.env.SEEKDB_PATH || envConfig.SEEKDB_PATH
    ? path.resolve(process.env.SEEKDB_PATH || envConfig.SEEKDB_PATH || '')
    : path.resolve(PROJECT_ROOT, 'seekdb.db');

export function getSeekDbCentralDbOptions(): SeekDbCentralDbOptions {
  const mode = resolveSeekDbMode();
  if (mode === 'embedded') {
    return {
      mode: 'embedded',
      path: SEEKDB_PATH,
      database: SEEKDB_DATABASE,
    };
  }
  return {
    mode: 'server',
    host: SEEKDB_HOST,
    port: SEEKDB_PORT,
    user: SEEKDB_USER,
    password: SEEKDB_PASSWORD,
    database: SEEKDB_DATABASE,
  };
}

// Per-checkout image tag so two installs on the same host don't share
// `nanoclaw-agent:latest` and clobber each other on rebuild.
export const CONTAINER_IMAGE_BASE = process.env.CONTAINER_IMAGE_BASE || getContainerImageBase(PROJECT_ROOT);
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || getDefaultContainerImage(PROJECT_ROOT);
// Install slug — stamped onto every spawned container via --label so
// cleanupOrphans only reaps containers from this install, not peers.
export const INSTALL_SLUG = getInstallSlug(PROJECT_ROOT);
export const CONTAINER_INSTALL_LABEL = `nanoclaw-install=${INSTALL_SLUG}`;
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10); // 10MB default
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const ONECLI_API_KEY = process.env.ONECLI_API_KEY || envConfig.ONECLI_API_KEY;
export const MAX_MESSAGES_PER_PROMPT = Math.max(1, parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10);
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
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
  const candidates = [process.env.TZ, envConfig.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
