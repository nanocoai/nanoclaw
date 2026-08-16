/**
 * Validation + hold-request builders for agent-initiated self-modification.
 *
 * Two actions the container can write into messages_out (via the self-mod
 * MCP tools): install_packages, add_mcp_server. The delivery registry wraps
 * each one with the guard (see ./guard.ts — unconditional hold from the
 * container path): validation here runs as the wrapper's precheck, and the
 * hold builders create the approval card when the guard holds. On approve,
 * the continuation re-enters the wrapped action and ./apply.ts runs.
 *
 * Host-side sanitization for install_packages is defense-in-depth — the MCP
 * tool validates first. Both layers matter: the DB row carries the payload
 * verbatim through to shell exec on apply.
 */
import { createHash } from 'node:crypto';

import { mcpServerPluginOwner, parseMcpServerConfig, validateMcpServerName } from '../../container-config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';

export function validateInstallPackages(content: Record<string, unknown>, session: Session): boolean {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'install_packages failed: agent group not found.');
    return false;
  }

  const apt = (content.apt as string[]) || [];
  const npm = (content.npm as string[]) || [];

  const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
  const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
  const MAX_PACKAGES = 20;
  if (apt.length + npm.length === 0) {
    notifyAgent(session, 'install_packages failed: at least one apt or npm package is required.');
    return false;
  }
  if (apt.length + npm.length > MAX_PACKAGES) {
    notifyAgent(session, `install_packages failed: max ${MAX_PACKAGES} packages per request.`);
    return false;
  }
  const invalidApt = apt.find((p) => !APT_RE.test(p));
  if (invalidApt) {
    notifyAgent(session, `install_packages failed: invalid apt package name "${invalidApt}".`);
    log.warn('install_packages: invalid apt package rejected', { pkg: invalidApt });
    return false;
  }
  const invalidNpm = npm.find((p) => !NPM_RE.test(p));
  if (invalidNpm) {
    notifyAgent(session, `install_packages failed: invalid npm package name "${invalidNpm}".`);
    log.warn('install_packages: invalid npm package rejected', { pkg: invalidNpm });
    return false;
  }
  return true;
}

export async function requestInstallPackagesHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;
  const apt = (content.apt as string[]) || [];
  const npm = (content.npm as string[]) || [];
  const reason = (content.reason as string) || '';

  const packageList = [...apt.map((p) => `apt: ${p}`), ...npm.map((p) => `npm: ${p}`)].join(', ');
  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'install_packages',
    payload: { apt, npm, reason },
    title: 'Install Packages Request',
    question: `Agent "${agentGroup.name}" is attempting to install a package + rebuild container:\n${packageList}${reason ? `\nReason: ${reason}` : ''}`,
  });
}

const MAX_MCP_ARGS = 32;
const MAX_MCP_ENV_VARS = 32;
/** Byte cap on the rendered approval card body (precedent: GATE_CARD_BODY_MAX in agent-route.ts). */
const MCP_APPROVAL_CARD_MAX_BYTES = 1500;
/**
 * Byte cap on the raw payload. The card cap alone no longer bounds the
 * payload once secret-shaped values render as small placeholders, so the
 * payload gets its own limit (PEM keys ~4KB fit comfortably).
 */
const MCP_PAYLOAD_MAX_BYTES = 16384;

/**
 * Secret-shaped env keys / values (env values and args elements). Matching
 * values are never rendered raw on the approval card — they show as a
 * `<redacted: N bytes, sha256 XXXXXXXX>` placeholder — but the verbatim
 * value still goes into the approval payload and is applied unchanged.
 */
// Exported for the template/plugin stamp path, where the same patterns drive
// rejection (a real key must never ship inside a template) instead of card
// redaction. Keep the two uses on one definition.
export const SECRET_ENV_KEY_RE = /(TOKEN|SECRET|PASSW(OR)?D|API_?KEY|APIKEY|CREDENTIAL|PRIVATE_?KEY|AUTH)/i;
export const SECRET_VALUE_RE = /^(sk-|ghp_|github_pat_|xox[a-z]-|AKIA|-----BEGIN )/;

/** Card-only placeholder for a secret-shaped value: byte length + sha256 fingerprint. */
function redactSecret(value: string): string {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 8);
  return `<redacted: ${Buffer.byteLength(value, 'utf8')} bytes, sha256 ${digest}>`;
}

/**
 * Render every control/format/invisible/bidi character — and backtick, so a
 * payload can never close the card's code fence — as a visible \uXXXX
 * escape. Applied to JSON-encoded payload fields: JSON.stringify already
 * escapes chars below 0x20, this covers the rest (Cf bidi/zero-width chars,
 * U+2028/U+2029 line separators, private-use, lone surrogates).
 * Exported for tests.
 */
export function escapeInvisibles(s: string): string {
  return s.replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u2028\u2029`]/gu, (c) => {
    const cp = c.codePointAt(0) ?? 0;
    return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`;
  });
}

export function validateAddMcpServer(content: Record<string, unknown>, session: Session): boolean {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'add_mcp_server failed: agent group not found.');
    return false;
  }
  const serverName = typeof content.name === 'string' ? content.name : '';
  if (!serverName) {
    notifyAgent(session, 'add_mcp_server failed: name is required.');
    return false;
  }
  let serverConfig;
  try {
    validateMcpServerName(serverName);
    serverConfig = parseMcpServerConfig(content);
    // eslint-disable-next-line no-catch-all/no-catch-all -- parse failures are expected user input errors
  } catch (err) {
    notifyAgent(session, `add_mcp_server failed: ${err instanceof Error ? err.message : String(err)}.`);
    return false;
  }

  // Plugin-owned servers are template content: reject before an approval round
  // is spent — the only sanctioned change path is updating the plugin and
  // re-stamping (apply.ts re-checks in case an approval races a restamp).
  const configRow = getContainerConfig(agentGroup.id);
  const existing = configRow ? (JSON.parse(configRow.mcp_servers) as Record<string, unknown>)[serverName] : undefined;
  const owner = mcpServerPluginOwner(existing);
  if (owner) {
    notifyAgent(
      session,
      `add_mcp_server failed: server "${serverName}" is owned by plugin "${owner}". ` +
        'Plugin servers can only be changed by updating the plugin and re-stamping (ncl groups create --template <ref> --yes).',
    );
    return false;
  }

  // cwd only means something for plugin-shipped servers (the runtime resolves
  // it against the plugin root, which approval-added servers never have — it
  // would be silently dropped). Rejecting keeps the card honest: an approver
  // must never sign a working directory that won't take effect.
  if (serverConfig.type !== 'http' && serverConfig.cwd !== undefined) {
    notifyAgent(session, 'add_mcp_server failed: cwd is only supported for plugin-shipped servers.');
    return false;
  }

  const args = serverConfig.type === 'http' ? [] : (serverConfig.args ?? []);
  const env = serverConfig.type === 'http' ? {} : (serverConfig.env ?? {});

  if (args.length > MAX_MCP_ARGS) {
    notifyAgent(session, `add_mcp_server failed: max ${MAX_MCP_ARGS} args per server.`);
    return false;
  }
  if (Object.keys(env).length > MAX_MCP_ENV_VARS) {
    notifyAgent(session, `add_mcp_server failed: max ${MAX_MCP_ENV_VARS} env vars per server.`);
    return false;
  }
  if (Buffer.byteLength(JSON.stringify({ name: serverName, ...serverConfig }), 'utf8') > MCP_PAYLOAD_MAX_BYTES) {
    notifyAgent(session, `add_mcp_server failed: payload exceeds ${MCP_PAYLOAD_MAX_BYTES} bytes.`);
    return false;
  }
  return true;
}

export async function requestAddMcpServerHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return; // precheck already answered the requester
  const serverName = content.name as string;
  const serverConfig = parseMcpServerConfig(content);

  let fields: string[];
  if (serverConfig.type === 'http') {
    // Redact per path segment and per query value, never the origin — the
    // admin must always see the true destination host, and SECRET_VALUE_RE
    // is start-anchored so testing the whole URL would match nothing. A
    // Zapier-style https://host/s/<token>/mcp must not render the token raw.
    const u = new URL(serverConfig.url);
    const redactSeg = (s: string): string => (SECRET_VALUE_RE.test(s) ? redactSecret(s) : s);
    const path = u.pathname.split('/').map(redactSeg).join('/');
    // Keep the query byte-faithful unless a value actually needs redacting —
    // re-serializing decodes percent-escapes and can invent structure.
    const entries = [...u.searchParams];
    const query = entries.some(([, v]) => SECRET_VALUE_RE.test(v))
      ? `?${entries.map(([k, v]) => `${k}=${redactSeg(v)}`).join('&')}`
      : u.search;
    const displayUrl = u.origin + path + query;
    fields = [
      `name: ${escapeInvisibles(JSON.stringify(serverName))}`,
      `type: ${escapeInvisibles(JSON.stringify(serverConfig.type))}`,
      `url: ${escapeInvisibles(JSON.stringify(displayUrl))}`,
    ];
    if (serverConfig.headers !== undefined) {
      const displayHeaders = Object.fromEntries(
        Object.entries(serverConfig.headers).map(([k, v]) => [
          k,
          SECRET_ENV_KEY_RE.test(k) || SECRET_VALUE_RE.test(v) ? redactSecret(v) : v,
        ]),
      );
      fields.push(`headers: ${escapeInvisibles(JSON.stringify(displayHeaders))}`);
    }
  } else {
    const args = serverConfig.args ?? [];
    const env = serverConfig.env ?? {};
    // Card-only view: secret-shaped values render as redaction placeholders;
    // the payload below keeps the verbatim values.
    const displayArgs = args.map((a) => (SECRET_VALUE_RE.test(a) ? redactSecret(a) : a));
    const displayEnv = Object.fromEntries(
      Object.entries(env).map(([k, v]) => [
        k,
        SECRET_ENV_KEY_RE.test(k) || SECRET_VALUE_RE.test(v) ? redactSecret(v) : v,
      ]),
    );
    fields = [
      `name: ${escapeInvisibles(JSON.stringify(serverName))}`,
      `command: ${escapeInvisibles(JSON.stringify(serverConfig.command))}`,
      `args: ${escapeInvisibles(JSON.stringify(displayArgs))}`,
      `env: ${escapeInvisibles(JSON.stringify(displayEnv))}`,
    ];
  }
  if (serverConfig.instructions !== undefined) {
    fields.push(`instructions: ${escapeInvisibles(JSON.stringify(serverConfig.instructions))}`);
  }

  // JSON-encode each field (exact boundaries, embedded newlines render as
  // visible \n escapes), escape invisibles/backticks, and wrap the payload
  // in a code fence — no payload content can add lines to the card, spoof
  // another field, or break out of the fence.
  const question =
    `Agent "${agentGroup.name}" is attempting to add a new MCP server:\n` + '```\n' + fields.join('\n') + '\n' + '```';
  if (Buffer.byteLength(question, 'utf8') > MCP_APPROVAL_CARD_MAX_BYTES) {
    notifyAgent(
      session,
      `add_mcp_server failed: rendered approval card exceeds ${MCP_APPROVAL_CARD_MAX_BYTES} bytes — trim the MCP configuration.`,
    );
    return;
  }
  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'add_mcp_server',
    payload: { name: serverName, ...serverConfig },
    title: 'Add MCP Request',
    question,
  });
}
