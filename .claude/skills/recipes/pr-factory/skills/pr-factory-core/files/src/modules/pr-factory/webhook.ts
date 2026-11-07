/**
 * GitHub webhook receiver. Mounts on the shared webhook server at
 * /webhook/github. Verifies HMAC-SHA256 signature, filters for
 * pull_request.opened and pull_request.synchronize, hands the parsed
 * PR off to the caller.
 */
import crypto from 'crypto';
import http from 'http';

import { registerWebhookHandler } from '../../webhook-server.js';
import { log } from '../../log.js';
import { prLog } from './activity-log.js';

export interface PREvent {
  action: string;
  number: number;
  title: string;
  body: string;
  author: string;
  repoFullName: string;
  headSha: string;
  diffUrl: string;
  htmlUrl: string;
  merged: boolean;
  draft: boolean;
}

function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

export function registerGitHubWebhook(secret: string, onPullRequest: (pr: PREvent) => Promise<void>): void {
  registerWebhookHandler('github', async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method not allowed');
      return;
    }

    const body = await readBody(req);
    const signature = req.headers['x-hub-signature-256'] as string;

    if (!signature || !verifySignature(body, signature, secret)) {
      log.warn('GitHub webhook: invalid signature');
      res.writeHead(401);
      res.end('Invalid signature');
      return;
    }

    res.writeHead(200);
    res.end('OK');

    const event = req.headers['x-github-event'] as string;
    if (event !== 'pull_request') return;

    let payload: { action?: string; pull_request?: Record<string, unknown>; repository?: Record<string, unknown> };
    try {
      payload = JSON.parse(body);
    } catch (err) {
      log.error('GitHub webhook: failed to parse payload', { err });
      return;
    }
    const validActions = ['opened', 'synchronize', 'closed', 'ready_for_review', 'converted_to_draft'];
    if (!validActions.includes(payload.action!)) return;

    const pr = payload.pull_request as Record<string, unknown>;
    const repo = payload.repository as Record<string, unknown>;
    const head = pr.head as Record<string, unknown>;
    const user = pr.user as Record<string, unknown>;
    const prEvent: PREvent = {
      action: payload.action!,
      number: pr.number as number,
      title: pr.title as string,
      body: (pr.body as string) || '',
      author: user.login as string,
      repoFullName: repo.full_name as string,
      headSha: head.sha as string,
      diffUrl: pr.diff_url as string,
      htmlUrl: pr.html_url as string,
      merged: !!(pr.merged as boolean),
      draft: !!(pr.draft as boolean),
    };

    log.info('GitHub webhook: PR event', { action: prEvent.action, pr: prEvent.number, repo: prEvent.repoFullName });
    prLog(prEvent.number, prEvent.repoFullName, 'webhook_received', {
      action: prEvent.action,
      author: prEvent.author,
      title: prEvent.title,
      draft: prEvent.draft,
    });
    onPullRequest(prEvent).catch((err) => {
      log.error('Failed to handle PR event', {
        err,
        prNumber: prEvent.number,
        repo: prEvent.repoFullName,
        category: 'pr-webhook',
      });
    });
  });
}
