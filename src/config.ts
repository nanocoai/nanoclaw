import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { getContainerImageBase, getDefaultContainerImage, getInstallSlug } from './install-slug.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'ONECLI_API_KEY',
  'TZ',
  // Container runtime selection + Apple Container bridge knobs. NOTE: .env is
  // never loaded into process.env (see env.ts), so these MUST be read here via
  // readEnvFile to survive the launchd/systemd path; setup/service.ts also
  // emits CONTAINER_RUNTIME into the service env so the flip is durable.
  'CONTAINER_RUNTIME',
  'NANOCLAW_HOST_GATEWAY_IP',
  'ONECLI_FORWARD_BIND',
  'NANOCLAW_EGRESS_LOCKDOWN',
  // Remote OneCLI: rewrite the gateway host the server injects (by default the
  // literal "host.docker.internal") to a LAN-reachable address. Format "from=to",
  // e.g. "host.docker.internal=192.168.0.99".
  'ONECLI_GATEWAY_REWRITE',
]);

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'mount-allowlist.json');
export const SENDER_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'sender-allowlist.json');
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// Per-checkout image tag so two installs on the same host don't share
// `nanoclaw-agent:latest` and clobber each other on rebuild.
export const CONTAINER_IMAGE_BASE = process.env.CONTAINER_IMAGE_BASE || getContainerImageBase(PROJECT_ROOT);
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || getDefaultContainerImage(PROJECT_ROOT);
// Install slug — stamped onto every spawned container via --label so
// cleanupOrphans only reaps containers from this install, not peers.
export const INSTALL_SLUG = getInstallSlug(PROJECT_ROOT);
export const CONTAINER_INSTALL_LABEL = `nanoclaw-install=${INSTALL_SLUG}`;
// Container runtime: 'docker' (default) or 'container' (Apple Container).
// Single source of truth — container-runtime.ts / onecli-forwarder.ts /
// egress-lockdown.ts import from here, never read process.env directly.
export const CONTAINER_RUNTIME =
  (process.env.CONTAINER_RUNTIME || envConfig.CONTAINER_RUNTIME || 'docker') === 'container' ? 'container' : 'docker';
// Override the autodetected Apple Container bridge gateway IP (192.168.64.1).
export const NANOCLAW_HOST_GATEWAY_IP =
  process.env.NANOCLAW_HOST_GATEWAY_IP || envConfig.NANOCLAW_HOST_GATEWAY_IP || '';
// Override the OneCLI forwarder bind IP (must be in the 192.168.64.0/24 bridge subnet).
export const ONECLI_FORWARD_BIND = process.env.ONECLI_FORWARD_BIND || envConfig.ONECLI_FORWARD_BIND || '';
// Remote OneCLI gateway-host rewrite "from=to" (e.g. "host.docker.internal=192.168.0.99").
// An explicit OVERRIDE: when set, the host rewrites this exact gateway host in
// OneCLI's injected proxy env. Usually unnecessary — for a remote ONECLI_URL the
// rewrite target is derived automatically (see ONECLI_REMOTE_HOST). Use this only
// when the gateway is reachable at a different address than the control API host
// (e.g. a Tailscale IP). Validated eagerly so a malformed value fails fast.
export const ONECLI_GATEWAY_REWRITE = process.env.ONECLI_GATEWAY_REWRITE || envConfig.ONECLI_GATEWAY_REWRITE || '';
if (ONECLI_GATEWAY_REWRITE) {
  const eq = ONECLI_GATEWAY_REWRITE.indexOf('=');
  if (eq <= 0 || eq === ONECLI_GATEWAY_REWRITE.length - 1) {
    throw new Error(
      `Invalid ONECLI_GATEWAY_REWRITE="${ONECLI_GATEWAY_REWRITE}" — expected "from=to", ` +
        `e.g. host.docker.internal=192.168.0.99`,
    );
  }
}
// Egress lockdown is Docker-bridge-only; hard-gated off under Apple Container.
export const EGRESS_LOCKDOWN = (process.env.NANOCLAW_EGRESS_LOCKDOWN || envConfig.NANOCLAW_EGRESS_LOCKDOWN) === 'true';
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10); // 10MB default
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const ONECLI_API_KEY = process.env.ONECLI_API_KEY || envConfig.ONECLI_API_KEY;
// Hostname of a REMOTE OneCLI gateway — empty when OneCLI is local/loopback.
// Drives two things: the forwarder skips itself when this is set, and the proxy
// host OneCLI bakes into the injected env (the literal "host.docker.internal",
// which assumes a Docker-Desktop-local agent) is retargeted to this address so a
// remote agent reaches the actual gateway. ONECLI_GATEWAY_REWRITE overrides it.
export function deriveOneCliRemoteHost(url: string | undefined): string {
  if (!url) return '';
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return '';
  }
  // URL.hostname returns IPv6 literals bracketed (e.g. "[::1]"), so match both forms.
  if (!host || host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]') return '';
  return host;
}
export const ONECLI_REMOTE_HOST = deriveOneCliRemoteHost(ONECLI_URL);
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
