/**
 * slack-canvas component — renders PR Factory markdown as Slack Canvases.
 *
 * Registers two things at import time:
 *
 *   1. A canvas provider on pr-factory-core's canvas seam (canvas.ts).
 *      Core's test-plan and test-result posts call `createCanvas` and fall
 *      back to plain text + .md upload when it returns null; with this
 *      provider installed they render as canvases shared into the channel.
 *
 *   2. A delivery file transform (core's single-slot `registerFileTransform`
 *      hook — the one core edit this component's apply makes) that converts
 *      .md outbox attachments from the PR Factory worker into canvas links,
 *      so reviews land as inline documents instead of downloadable files.
 *      Scoped to the worker agent group's Slack sessions; everything else
 *      passes through untouched.
 *
 * Uses the worker bot token (SLACK_BOT_TOKEN via reactions.getBotToken) for
 * the Canvas API calls.
 */
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { registerFileTransform } from '../../delivery.js';
import { log } from '../../log.js';
import { WORKER_FOLDER } from './bootstrap.js';
import { createCanvas, registerCanvasProvider, type CanvasResult } from './canvas.js';
import { getBotToken } from './reactions.js';

// ── Slack Canvas API client ──

interface SlackApiResponse {
  ok: boolean;
  error?: string;
}

interface CanvasCreateResponse extends SlackApiResponse {
  canvas_id?: string;
}

interface FileInfoResponse extends SlackApiResponse {
  file?: { permalink?: string };
}

async function slackApi<T extends SlackApiResponse>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getBotToken()}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

/** Slack canvases reject numbered lists inside bullet lists. Convert all numbered lists to bullets. */
function sanitizeForCanvas(md: string): string {
  return md.replace(/^(\s*)\d+\.\s/gm, '$1• ');
}

/**
 * Create a Slack Canvas from markdown, grant read access to a channel, and
 * return the canvas ID + permalink for embedding in a message. Returns null
 * on failure (logs the error) so callers fall back to file upload.
 */
async function createSlackCanvas(title: string, markdown: string, channelId: string): Promise<CanvasResult | null> {
  const create = await slackApi<CanvasCreateResponse>('canvases.create', {
    title,
    document_content: { type: 'markdown', markdown: sanitizeForCanvas(markdown) },
  });

  if (!create.ok || !create.canvas_id) {
    log.warn('Canvas creation failed', {
      error: create.error,
      title,
      markdownLength: markdown.length,
      response: JSON.stringify(create),
    });
    return null;
  }

  const canvasId = create.canvas_id;

  // Grant read access to the channel so thread participants can view it
  const access = await slackApi('canvases.access.set', {
    canvas_id: canvasId,
    access_level: 'read',
    channel_ids: [channelId],
  });

  if (!access.ok) {
    log.warn('Canvas access.set failed', { error: access.error, canvasId, channelId });
    // Canvas exists but isn't shared — still return it, permalink will work
    // for the bot but viewers may need to request access.
  }

  // Fetch the permalink (canvas IDs are file IDs).
  // files.info requires form-urlencoded, not JSON — use GET with query params.
  const infoRes = await fetch(`https://slack.com/api/files.info?file=${canvasId}`, {
    headers: { Authorization: `Bearer ${getBotToken()}` },
  });
  const info = (await infoRes.json()) as FileInfoResponse;
  const permalink = info.file?.permalink;

  if (!permalink) {
    log.warn('Canvas permalink not found', { canvasId });
    return null;
  }

  return { canvasId, permalink };
}

registerCanvasProvider(createSlackCanvas);

// ── .md → canvas delivery transform ──

/**
 * Build a canvas title matching the "Type — PR #N" pattern used by test
 * plans / results, e.g. "review-pr-2383.md" → "Review — PR #2383".
 */
function canvasTitleFor(filename: string): { title: string; linkLabel: string } {
  const base = filename.replace(/\.md$/, '');
  const prMatch = base.match(/^(.+?)[-_]pr[-_](\d+)/);
  if (prMatch) {
    const kind = prMatch[1].replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return { title: `${kind} — PR #${prMatch[2]}`, linkLabel: `View ${kind.toLowerCase()}` };
  }
  const title = base.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { title, linkLabel: `View ${title.toLowerCase()}` };
}

registerFileTransform(async (session, content, files) => {
  // Scope: only the PR Factory worker's Slack sessions convert .md files.
  // (When core hasn't bootstrapped — e.g. the module is inert — the worker
  // group doesn't exist and everything passes through.)
  const worker = getAgentGroupByFolder(WORKER_FOLDER);
  if (!worker || session.agent_group_id !== worker.id) return { files, content };

  const mdFiles = files.filter((f) => f.filename.endsWith('.md'));
  if (mdFiles.length === 0) return { files, content };

  const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
  if (!mg || mg.channel_type !== 'slack') return { files, content };
  const bareChannel = mg.platform_id.replace(/^slack:/, '');

  const remaining = files.filter((f) => !f.filename.endsWith('.md'));
  let text = (content.text as string) || (content.markdown as string) || '';

  for (const md of mdFiles) {
    const { title, linkLabel } = canvasTitleFor(md.filename);
    // Through the seam: inherits its try/catch, so a provider failure keeps
    // the file as an upload instead of dropping it.
    const canvas = await createCanvas(title, md.data.toString('utf8'), bareChannel);
    if (canvas) {
      text += (text ? '\n' : '') + `[${linkLabel}](${canvas.permalink})`;
    } else {
      remaining.push(md); // fallback: keep as file
    }
  }

  return {
    files: remaining.length > 0 ? remaining : undefined,
    content: { ...content, text },
  };
});
