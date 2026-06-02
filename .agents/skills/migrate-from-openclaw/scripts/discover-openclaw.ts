/**
 * Discover an existing OpenClaw installation and emit a structured summary.
 *
 * Usage: pnpm exec tsx .claude/skills/migrate-from-openclaw/scripts/discover-openclaw.ts [--state-dir <path>]
 *
 * Checks (in order): --state-dir arg, $OPENCLAW_STATE_DIR, ~/.openclaw, ~/.clawdbot
 * Parses openclaw.json (JSON5-tolerant), scans workspace for identity/memory files,
 * checks cron jobs, MCP servers, and channel credentials.
 *
 * Emits a status block on stdout:
 *   === NANOCLAW MIGRATE: DISCOVERY ===
 *   ...
 *   === END ===
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

// ---------------------------------------------------------------------------
// JSON5-tolerant parser (no dependency)
// ---------------------------------------------------------------------------

function parseJson5(text: string): unknown {
  // Strip single-line comments (// ...) that aren't inside strings
  let cleaned = text.replace(
    /("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g,
    (match, str) => (str ? str : ''),
  );
  // Strip block comments (/* ... */)
  cleaned = cleaned.replace(
    /("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\//g,
    (match, str) => (str ? str : ''),
  );
  // Strip trailing commas before } or ]
  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(cleaned);
}

// ---------------------------------------------------------------------------
// Status block emitter (mirrors setup/status.ts convention)
// ---------------------------------------------------------------------------

function emitStatus(fields: Record<string, string | number | boolean>): void {
  const lines = ['=== NANOCLAW MIGRATE: DISCOVERY ==='];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push('=== END ===');
  console.log(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(): { stateDir?: string } {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--state-dir' && args[i + 1]) {
      return { stateDir: args[i + 1] };
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function resolveStateDir(explicit?: string): string | null {
  const home = os.homedir();
  const candidates: string[] = [];

  if (explicit) {
    // Expand ~ prefix
    const expanded = explicit.startsWith('~')
      ? path.join(home, explicit.slice(1))
      : explicit;
    candidates.push(expanded);
  }

  if (process.env.OPENCLAW_STATE_DIR) {
    candidates.push(process.env.OPENCLAW_STATE_DIR);
  }

  candidates.push(path.join(home, '.openclaw'));
  candidates.push(path.join(home, '.clawdbot'));

  for (const dir of candidates) {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      return dir;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function loadConfig(
  stateDir: string,
): Record<string, unknown> | null {
  for (const name of ['openclaw.json', 'clawdbot.json']) {
    const configPath = path.join(stateDir, name);
    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        return parseJson5(raw) as Record<string, unknown>;
      } catch {
        // Try next name
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Channel detection
// ---------------------------------------------------------------------------

interface ChannelInfo {
  name: string;
  hasCreds: boolean;
}

const SUPPORTED_CHANNELS = new Set([
  'whatsapp',
  'telegram',
  'slack',
  'discord',
]);

// Fields that indicate a credential is present for each channel
const CREDENTIAL_FIELDS: Record<string, string[]> = {
  telegram: ['botToken'],
  discord: ['token'],
  slack: ['botToken', 'appToken'],
  whatsapp: [], // Auth-state based, no token
  signal: ['account'],
  imessage: [],
  matrix: ['homeserverUrl', 'accessToken'],
  irc: ['server'],
  msteams: ['appId'],
  feishu: ['appId'],
  googlechat: [],
  mattermost: ['token', 'url'],
  zalo: [],
  bluebubbles: ['url'],
};

const ALL_KNOWN_CHANNELS = new Set([
  'whatsapp', 'telegram', 'slack', 'discord', 'signal',
  'imessage', 'matrix', 'irc', 'msteams', 'feishu',
  'googlechat', 'mattermost', 'zalo', 'bluebubbles',
]);

function detectChannels(
  config: Record<string, unknown>,
): ChannelInfo[] {
  // Check both config.channels.* (newer) and top-level config.* (older/legacy)
  const channelsSections: Record<string, unknown> = {};

  // Source 1: channels.* (standard location)
  const nested = config.channels as Record<string, unknown> | undefined;
  if (nested) {
    for (const [k, v] of Object.entries(nested)) {
      if (v && typeof v === 'object') channelsSections[k] = v;
    }
  }

  // Source 2: top-level keys matching known channel names (legacy format)
  for (const key of Object.keys(config)) {
    if (ALL_KNOWN_CHANNELS.has(key) && !channelsSections[key]) {
      const v = config[key];
      if (v && typeof v === 'object') channelsSections[key] = v;
    }
  }

  const results: ChannelInfo[] = [];

  for (const [name, section] of Object.entries(channelsSections)) {
    if (!section || typeof section !== 'object') continue;
    const ch = section as Record<string, unknown>;

    // Check if any credential field is present and non-empty
    const credFields = CREDENTIAL_FIELDS[name] ?? [];
    let hasCreds = false;

    for (const field of credFields) {
      const val = ch[field];
      if (val && (typeof val === 'string' || typeof val === 'object')) {
        hasCreds = true;
        break;
      }
    }

    // Also check accounts for multi-account setups
    if (!hasCreds && ch.accounts && typeof ch.accounts === 'object') {
      for (const acct of Object.values(
        ch.accounts as Record<string, unknown>,
      )) {
        if (!acct || typeof acct !== 'object') continue;
        const a = acct as Record<string, unknown>;
        for (const field of credFields) {
          if (
            a[field] &&
            (typeof a[field] === 'string' || typeof a[field] === 'object')
          ) {
            hasCreds = true;
            break;
          }
        }
        if (hasCreds) break;
      }
    }

    // WhatsApp: check for auth state directory instead of token
    if (name === 'whatsapp' && !hasCreds) {
      // Will be checked separately via agents directory
      hasCreds = false;
    }

    results.push({ name, hasCreds });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Workspace scanning
// ---------------------------------------------------------------------------

const WORKSPACE_FILES = [
  'SOUL.md',
  'USER.md',
  'MEMORY.md',
  'IDENTITY.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'BOOTSTRAP.md',
  'AGENTS.md',
];

function findWorkspace(stateDir: string, config: Record<string, unknown> | null): {
  dir: string | null;
  files: string[];
} {
  // Check config-specified workspace path first (agent.workspace or agents.defaults.workspace)
  const configPaths: string[] = [];
  if (config) {
    const agentWs = (config.agent as Record<string, unknown> | undefined)?.workspace as string | undefined;
    if (agentWs) configPaths.push(agentWs.startsWith('~') ? path.join(os.homedir(), agentWs.slice(1)) : agentWs);
    const defaultsWs = ((config.agents as Record<string, unknown> | undefined)?.defaults as Record<string, unknown> | undefined)?.workspace as string | undefined;
    if (defaultsWs) configPaths.push(defaultsWs.startsWith('~') ? path.join(os.homedir(), defaultsWs.slice(1)) : defaultsWs);
  }

  // Check config-specified paths, then default locations
  const candidates = [
    ...configPaths,
    ...['workspace', 'workspace.default'].map((n) => path.join(stateDir, n)),
  ];

  for (const ws of candidates) {
    if (fs.existsSync(ws) && fs.statSync(ws).isDirectory()) {
      const found = WORKSPACE_FILES.filter((f) =>
        fs.existsSync(path.join(ws, f)),
      );
      if (found.length > 0) {
        return { dir: ws, files: found };
      }
    }
  }

  // Check agent-specific workspaces
  const agentsDir = path.join(stateDir, 'agents');
  if (fs.existsSync(agentsDir)) {
    for (const agentId of fs.readdirSync(agentsDir)) {
      for (const wsName of ['workspace', 'workspace.default']) {
        const ws = path.join(agentsDir, agentId, wsName);
        if (fs.existsSync(ws) && fs.statSync(ws).isDirectory()) {
          const found = WORKSPACE_FILES.filter((f) =>
            fs.existsSync(path.join(ws, f)),
          );
          if (found.length > 0) {
            return { dir: ws, files: found };
          }
        }
      }
    }
  }

  return { dir: null, files: [] };
}

// ---------------------------------------------------------------------------
// Daily memory file detection
// ---------------------------------------------------------------------------

function countDailyMemoryFiles(workspaceDir: string | null): number {
  if (!workspaceDir) return 0;
  const memoryDir = path.join(workspaceDir, 'memory');
  if (!fs.existsSync(memoryDir) || !fs.statSync(memoryDir).isDirectory()) {
    return 0;
  }
  try {
    return fs
      .readdirSync(memoryDir)
      .filter((f) => f.endsWith('.md'))
      .length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Skills detection
// ---------------------------------------------------------------------------

interface SkillInfo {
  name: string;
  source: string; // 'workspace' | 'shared' | 'personal' | 'project'
  path: string;
}

function detectSkills(
  stateDir: string,
  workspaceDir: string | null,
): SkillInfo[] {
  const skills: SkillInfo[] = [];
  const seen = new Set<string>();

  const scanDir = (dir: string, source: string) => {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
    try {
      for (const entry of fs.readdirSync(dir)) {
        const skillDir = path.join(dir, entry);
        if (!fs.statSync(skillDir).isDirectory()) continue;
        // A directory is a skill if it contains SKILL.md
        if (fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
          if (seen.has(entry)) continue;
          seen.add(entry);
          skills.push({ name: entry, source, path: skillDir });
        }
      }
    } catch {
      // ignore read errors
    }
  };

  // 1. Workspace skills
  if (workspaceDir) {
    scanDir(path.join(workspaceDir, 'skills'), 'workspace');
    // 4. Project-level shared skills
    scanDir(path.join(workspaceDir, '.agents', 'skills'), 'project');
  }

  // 2. Managed/shared skills
  scanDir(path.join(stateDir, 'skills'), 'shared');

  // 3. Personal cross-project skills
  const personalSkills = path.join(os.homedir(), '.agents', 'skills');
  scanDir(personalSkills, 'personal');

  return skills;
}

// ---------------------------------------------------------------------------
// Identity extraction
// ---------------------------------------------------------------------------

function extractIdentityName(stateDir: string, workspaceDir: string | null): string {
  if (!workspaceDir) return '';

  const identityPath = path.join(workspaceDir, 'IDENTITY.md');
  if (!fs.existsSync(identityPath)) return '';

  try {
    const content = fs.readFileSync(identityPath, 'utf-8');
    // IDENTITY.md uses key:value format, e.g. "name: Claw"
    const match = content.match(/^name:\s*(.+)/im);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Agent detection
// ---------------------------------------------------------------------------

function detectAgents(stateDir: string): string[] {
  const agentsDir = path.join(stateDir, 'agents');
  if (!fs.existsSync(agentsDir)) return [];

  try {
    return fs
      .readdirSync(agentsDir)
      .filter((f) => {
        const p = path.join(agentsDir, f);
        return fs.statSync(p).isDirectory() && !f.startsWith('.');
      });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Group detection — from session store and channel config
// ---------------------------------------------------------------------------

interface GroupInfo {
  channel: string;
  id: string; // Platform-specific ID (WhatsApp JID, Telegram chat ID, etc.)
  name: string;
  source: 'session' | 'config';
}

/**
 * Map OpenClaw session key channel:kind:id to NanoClaw JID format.
 * OpenClaw keys: "whatsapp:group:120...@g.us", "telegram:group:-10012345"
 * NanoClaw JIDs: "120...@g.us", "tg:-10012345", "dc:12345", "slack:C12345"
 */
function toNanoClawJid(channel: string, id: string): string {
  switch (channel) {
    case 'whatsapp':
      return id; // Already in JID format (120...@g.us)
    case 'telegram':
      return `tg:${id}`;
    case 'discord':
      return `dc:${id}`;
    case 'slack':
      return `slack:${id}`;
    default:
      return `${channel}:${id}`;
  }
}

function detectGroups(
  stateDir: string,
  config: Record<string, unknown> | null,
  agents: string[],
): GroupInfo[] {
  const groups: GroupInfo[] = [];
  const seen = new Set<string>();

  // Source 1: Session store — scan for group session keys
  for (const agentId of agents) {
    const sessionsPath = path.join(
      stateDir,
      'agents',
      agentId,
      'sessions',
      'sessions.json',
    );
    if (!fs.existsSync(sessionsPath)) continue;

    try {
      const raw = fs.readFileSync(sessionsPath, 'utf-8');
      const data = JSON.parse(raw) as Record<string, unknown>;

      // Sessions can be stored as an object with session keys, or as
      // { sessions: { key: entry } } or { entries: [...] }
      const entries =
        (data.sessions as Record<string, unknown>) ??
        (data.entries as Record<string, unknown>) ??
        data;

      for (const [key, value] of Object.entries(entries)) {
        // Match session keys like "whatsapp:group:120...@g.us"
        // or prefixed "agent:main:whatsapp:group:120...@g.us"
        // Also match DM sessions: "whatsapp:dm:number@s.whatsapp.net"
        const match = key.match(/(\w+):(group|dm|channel):(.+)$/i);
        if (!match) continue;

        const [, channel, kind, id] = match;
        // Skip DM sessions for group detection — they're individual chats
        if (kind === 'dm') continue;
        const dedupKey = `${channel}:${id}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        // Try to extract display name from session entry
        let name = '';
        if (value && typeof value === 'object') {
          const entry = value as Record<string, unknown>;
          name =
            (entry.displayName as string) ??
            (entry.label as string) ??
            (entry.subject as string) ??
            '';
        }

        groups.push({
          channel,
          id,
          name: name || id,
          source: 'session',
        });
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Source 2: Channel config — groups explicitly configured
  if (config) {
    const channels =
      (config.channels as Record<string, unknown> | undefined) ?? {};
    for (const [channelName, channelSection] of Object.entries(channels)) {
      if (!channelSection || typeof channelSection !== 'object') continue;
      const ch = channelSection as Record<string, unknown>;

      // WhatsApp/Telegram: channels.<channel>.groups.<groupId>
      const configGroups = ch.groups as Record<string, unknown> | undefined;
      if (configGroups) {
        for (const groupId of Object.keys(configGroups)) {
          const dedupKey = `${channelName}:${groupId}`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);
          groups.push({
            channel: channelName,
            id: groupId,
            name: groupId,
            source: 'config',
          });
        }
      }

      // Discord: channels.discord.guilds.<guildId>
      if (channelName === 'discord') {
        const guilds = ch.guilds as Record<string, unknown> | undefined;
        if (guilds) {
          for (const guildId of Object.keys(guilds)) {
            const dedupKey = `discord:${guildId}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);
            groups.push({
              channel: 'discord',
              id: guildId,
              name: guildId,
              source: 'config',
            });
          }
        }
      }
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Cron job counting
// ---------------------------------------------------------------------------

function countCronJobs(stateDir: string): {
  count: number;
  summaries: string[];
} {
  const jobsPath = path.join(stateDir, 'cron', 'jobs.json');
  if (!fs.existsSync(jobsPath)) return { count: 0, summaries: [] };

  try {
    const raw = fs.readFileSync(jobsPath, 'utf-8');
    const data = JSON.parse(raw) as {
      jobs?: Array<{ name?: string; enabled?: boolean }>;
    };
    const jobs = data.jobs ?? [];
    const summaries = jobs
      .filter((j) => j.enabled !== false)
      .map((j) => j.name || 'unnamed')
      .slice(0, 10);
    return { count: jobs.length, summaries };
  } catch {
    return { count: 0, summaries: [] };
  }
}

// ---------------------------------------------------------------------------
// Config-registered plugins and skills (with API keys)
// ---------------------------------------------------------------------------

interface ConfigPlugin {
  name: string;
  source: 'skills.entries' | 'plugins.entries';
  hasApiKey: boolean;
}

function detectConfigPlugins(
  config: Record<string, unknown>,
): ConfigPlugin[] {
  const results: ConfigPlugin[] = [];

  // Check skills.entries (e.g. openai-whisper-api with apiKey)
  const skills = config.skills as Record<string, unknown> | undefined;
  const skillEntries = skills?.entries as Record<string, unknown> | undefined;
  if (skillEntries) {
    for (const [name, entry] of Object.entries(skillEntries)) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const hasKey = !!(e.apiKey || e.token || e.key);
      results.push({ name, source: 'skills.entries', hasApiKey: hasKey });
    }
  }

  // Check plugins.entries (e.g. brave with config.webSearch.apiKey)
  const plugins = config.plugins as Record<string, unknown> | undefined;
  const pluginEntries = plugins?.entries as Record<string, unknown> | undefined;
  if (pluginEntries) {
    for (const [name, entry] of Object.entries(pluginEntries)) {
      if (!entry || typeof entry !== 'object') continue;
      // Deep-search for apiKey in nested config
      const hasKey = JSON.stringify(entry).includes('apiKey');
      results.push({ name, source: 'plugins.entries', hasApiKey: hasKey });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// MCP server detection
// ---------------------------------------------------------------------------

function detectMcpServers(
  config: Record<string, unknown>,
): string[] {
  const mcp = config.mcp as Record<string, unknown> | undefined;
  if (!mcp) return [];
  const servers = mcp.servers as Record<string, unknown> | undefined;
  if (!servers) return [];
  return Object.keys(servers);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const { stateDir: explicitDir } = parseArgs();
  const stateDir = resolveStateDir(explicitDir);

  if (!stateDir) {
    emitStatus({ STATUS: 'not_found' });
    return;
  }

  const config = loadConfig(stateDir);
  const channels = config ? detectChannels(config) : [];
  const { dir: workspaceDir, files: workspaceFiles } =
    findWorkspace(stateDir, config);
  const identityName = extractIdentityName(stateDir, workspaceDir);
  const agents = detectAgents(stateDir);
  const groups = detectGroups(stateDir, config, agents);
  const { count: cronCount, summaries: cronSummaries } =
    countCronJobs(stateDir);
  const mcpServers = config ? detectMcpServers(config) : [];
  const dailyMemoryFiles = countDailyMemoryFiles(workspaceDir);
  const skills = detectSkills(stateDir, workspaceDir);
  const configPlugins = config ? detectConfigPlugins(config) : [];

  // Format channels as "name(has_creds)" or "name(no_creds)"
  const channelList = channels
    .map((c) => `${c.name}(${c.hasCreds ? 'has_creds' : 'no_creds'})`)
    .join(',');

  // Separate supported vs unsupported
  const unsupported = channels
    .filter((c) => !SUPPORTED_CHANNELS.has(c.name))
    .map((c) => c.name)
    .join(',');

  // Format groups as "channel:id(name)" — also include NanoClaw JID mapping
  const groupList = groups
    .map(
      (g) =>
        `${g.channel}:${g.id}(${g.name})=>${toNanoClawJid(g.channel, g.id)}`,
    )
    .join('|');

  // Format skills as "name(source)" list
  const skillList = skills
    .map((s) => `${s.name}(${s.source})`)
    .join(',');

  // Dump raw top-level config keys so Claude can see what exists
  // beyond what this script specifically detects
  const configTopKeys = config ? Object.keys(config).sort().join(',') : 'none';
  const configChannelKeys = config?.channels
    ? Object.keys(config.channels as Record<string, unknown>).sort().join(',')
    : 'none';

  // List files/dirs at the state dir root for manual inspection
  let stateDirContents = 'unknown';
  try {
    stateDirContents = fs
      .readdirSync(stateDir)
      .filter((f) => !f.startsWith('.'))
      .sort()
      .join(',');
  } catch {
    // ignore
  }

  emitStatus({
    STATUS: 'found',
    STATE_DIR: stateDir,
    CONFIG_FOUND: config !== null,
    CONFIG_TOP_KEYS: configTopKeys,
    CONFIG_CHANNEL_KEYS: configChannelKeys,
    STATE_DIR_CONTENTS: stateDirContents,
    CHANNELS: channelList || 'none',
    UNSUPPORTED_CHANNELS: unsupported || 'none',
    WORKSPACE_DIR: workspaceDir || 'not_found',
    WORKSPACE_FILES: workspaceFiles.join(',') || 'none',
    IDENTITY_NAME: identityName || 'unknown',
    AGENT_COUNT: agents.length,
    AGENT_IDS: agents.join(',') || 'none',
    GROUPS: groupList || 'none',
    GROUP_COUNT: groups.length,
    DAILY_MEMORY_FILES: dailyMemoryFiles,
    SKILL_COUNT: skills.length,
    SKILLS: skillList || 'none',
    CONFIG_PLUGINS: configPlugins.map((p) => `${p.name}(${p.source}${p.hasApiKey ? ',has_key' : ''})`).join(',') || 'none',
    CONFIG_PLUGIN_COUNT: configPlugins.length,
    CRON_JOBS: cronCount,
    CRON_SUMMARIES: cronSummaries.join('|') || 'none',
    MCP_SERVERS: mcpServers.join(',') || 'none',
  });
}

main();
