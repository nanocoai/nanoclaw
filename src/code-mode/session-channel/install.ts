/**
 * Does this host have a managed Slack app, and how does it talk to the
 * service that minted it?
 *
 * Two sources, both written by setup and both already read by the running
 * host: the saved installation job (`data/slack-install.json`, the worker's
 * record — carries the app id, the service origin and the install's
 * progress) and the setup journal (`data/community-portal.json`, whose
 * `slackSetup` is the browser hand-over that precedes the job). The bearer
 * is the registry install token (`~/.config/nanoclaw/account.json`), the same
 * credential the host presents when it asks the service for an app.
 *
 * An app supplied by hand (a bot token pasted into .env with no managed
 * install) is not a session-channel install: the service knows nothing
 * about it, so there is nothing to bind. Absence here is the ordinary
 * answer, not an error — a sandbox works the same without a chat surface.
 */
import path from 'node:path';

import { readInstallIdentity } from '../../community-portal/install-identity.js';
import { readJson } from '../../community-portal/private-file.js';
import { DEFAULT_SLACK_SERVICE, readSlackJob } from '../../community-portal/slack-job.js';
import type { Journal } from '../../community-portal/device-client.js';

export interface SessionChannelInstall {
  /** Origin of the Slack service that manages this host's app. */
  serviceBase: string;
  /** The managed app the service provisioned for this host. */
  appId: string;
}

export interface SessionChannelCredentials extends SessionChannelInstall {
  /** Registry install token — the bearer for every service call. */
  token: string;
}

/** The managed Slack app this checkout installed, or null when there is none. */
export async function readSessionChannelInstall(root = process.cwd()): Promise<SessionChannelInstall | null> {
  const job = await readSlackJob(root);
  // A job that never reached the workspace (failed/expired) leaves no app
  // the service would let into a channel; one still installing does — the
  // create route answers with its own 409 until the install lands.
  if (job && job.app?.appId && !['failed', 'expired'].includes(job.status)) {
    return { serviceBase: job.serviceBase || DEFAULT_SLACK_SERVICE, appId: job.app.appId };
  }
  const journal = await readJson<Journal>(path.join(root, 'data/community-portal.json'));
  const saved = journal?.slackSetup;
  if (saved?.app?.appId) {
    return { serviceBase: saved.serviceBase || DEFAULT_SLACK_SERVICE, appId: saved.app.appId };
  }
  return null;
}

/** Install + bearer, or null when either half is missing. */
export async function readSessionChannelCredentials(
  root = process.cwd(),
  homeDir?: string,
): Promise<SessionChannelCredentials | null> {
  const install = await readSessionChannelInstall(root);
  if (!install) return null;
  const identity = await readInstallIdentity(homeDir ? { homeDir } : {});
  if (!identity) return null;
  return { ...install, token: identity.token };
}
