/**
 * Document rendering module — applies `render` system actions from the agent.
 *
 * The agent's `render_document` MCP tool writes a `render` system action; this
 * handler runs the standalone `nanoclaw-render` image (Quarto + LaTeX +
 * Chromium) over the session's workspace, ephemerally and host-mediated:
 *
 *   docker run --rm --network none --user <host uid> -v <workspace>:/work \
 *     nanoclaw-render render <source> --to <format> [-o <output>]
 *
 * Rendering is kept OUT of the agent image (lean agent, isolated toolchain).
 * The agent never touches docker; the container is network-isolated, holds no
 * secrets, mounts only the agent's workspace, and is destroyed after each run.
 * On completion the agent is notified (so it can attach the artifact).
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { registerDeliveryAction } from '../../delivery.js';
import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { sessionDir, writeSessionMessage } from '../../session-manager.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

const execFileAsync = promisify(execFile);

const RENDER_IMAGE = process.env.RENDER_IMAGE?.trim() || 'nanoclaw-render:latest';
const RENDER_TIMEOUT_MS = 180_000;
// Output extension by format (typst renders to PDF).
const EXT: Record<string, string> = { pdf: 'pdf', html: 'html', docx: 'docx', typst: 'pdf' };

function unsafe(p: string): boolean {
  return !p || p.startsWith('/') || p.split('/').includes('..');
}

function notify(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `render-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
}

async function handleRender(content: Record<string, unknown>, session: Session): Promise<void> {
  const source = String(content.source ?? '').trim();
  const format = String(content.format ?? 'pdf')
    .trim()
    .toLowerCase();
  const output = content.output ? String(content.output).trim() : '';

  // Defense in depth: re-validate paths host-side (the tool also checks).
  if (unsafe(source) || (output && unsafe(output))) {
    log.warn('render: rejected unsafe path', { source, output });
    notify(session, `Couldn't render "${source}": paths must be workspace-relative (no leading / or ..).`);
    return;
  }
  if (!EXT[format]) {
    notify(session, `Couldn't render "${source}": unsupported format "${format}".`);
    return;
  }

  const workspace = path.join(sessionDir(session.agent_group_id, session.id), 'agent');
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const args = [
    'run',
    '--rm',
    '--network',
    'none', // no network while rendering — isolates LaTeX/chromium
    '--user',
    `${uid}:${gid}`, // artifact owned by the host user, so the agent can read it back
    '--memory',
    '2g',
    '-v',
    `${workspace}:/work`,
    '-w',
    '/work',
    RENDER_IMAGE,
    'render',
    source,
    '--to',
    format,
    ...(output ? ['-o', output] : []),
  ];

  const outName = output || `${source.replace(/\.[^./]+$/, '')}.${EXT[format]}`;
  log.info('render: starting', { agentGroupId: session.agent_group_id, source, format });
  try {
    await execFileAsync(CONTAINER_RUNTIME_BIN, args, {
      timeout: RENDER_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    log.info('render: completed', { source, out: outName });
    notify(session, `Rendered "${source}" → ${outName} in your workspace. Attach it to share it with the user.`);
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr;
    const msg = (stderr && stderr.trim()) || (e instanceof Error ? e.message : String(e));
    log.error('render: failed', { source, error: msg.slice(0, 500) });
    notify(session, `Rendering "${source}" failed: ${msg.slice(0, 400)}`);
  }
}

registerDeliveryAction('render', handleRender);
