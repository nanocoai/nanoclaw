/**
 * Does this host have a managed chat app on `platform`, and how does it
 * talk to the service that minted it?
 *
 * The portal manages the install of a chat app for the host and keeps the
 * record on this machine: the saved installation job and the setup
 * journal (`data/community-portal.json`). The bearer for the service is
 * the registry install token (`~/.config/nanoclaw/account.json`), the same
 * credential the host presented when it asked the service for the app.
 *
 * Today the portal manages one kind of install, the Slack app
 * (community-portal/slack-job.ts); its record is read under the platform
 * key `slack`. Another platform whose install the portal manages gets a
 * reader here. An app supplied by hand (a token pasted into .env with no
 * managed install) is not a managed install: the service knows nothing
 * about it, so there is nothing to bind. Absence is the ordinary answer,
 * not an error — a sandbox works the same without a chat surface.
 */
import path from 'node:path';

import type { Journal } from '../../../community-portal/device-client.js';
import { readInstallIdentity } from '../../../community-portal/install-identity.js';
import { readJson } from '../../../community-portal/private-file.js';
import { DEFAULT_SLACK_SERVICE, readSlackJob } from '../../../community-portal/slack-job.js';

export interface ManagedInstall {
  /** The platform the app lives on (the key it was read under). */
  platform: string;
  /** Origin of the service that manages this host's app. */
  serviceBase: string;
  /** The managed app the service provisioned for this host. */
  appId: string;
  /**
   * The app's bot token, when the install delivered one. A platform half
   * may use it for one identity lookup; it is never logged and never sent
   * anywhere but the platform itself.
   */
  botToken?: string;
}

export interface ManagedInstallCredentials extends ManagedInstall {
  /** Registry install token — the bearer for every service call. */
  token: string;
}

export interface ManagedInstallOptions {
  root?: string;
  homeDir?: string;
}

type Reader = (root: string) => Promise<Omit<ManagedInstall, 'platform'> | null>;

async function readSlackManagedInstall(root: string): Promise<Omit<ManagedInstall, 'platform'> | null> {
  const job = await readSlackJob(root);
  // A job that never reached the workspace (failed/expired) leaves no app
  // the service would let into a channel; one still installing does — the
  // create route answers with its own 409 until the install lands.
  if (job && job.app?.appId && !['failed', 'expired'].includes(job.status)) {
    return {
      serviceBase: job.serviceBase || DEFAULT_SLACK_SERVICE,
      appId: job.app.appId,
      ...(job.app.botToken ? { botToken: job.app.botToken } : {}),
    };
  }
  const journal = await readJson<Journal>(path.join(root, 'data/community-portal.json'));
  const saved = journal?.slackSetup;
  if (saved?.app?.appId) {
    return {
      serviceBase: saved.serviceBase || DEFAULT_SLACK_SERVICE,
      appId: saved.app.appId,
      ...(saved.app.botToken ? { botToken: saved.app.botToken } : {}),
    };
  }
  return null;
}

/** The portal's managed-install records, by platform. */
const readers: Record<string, Reader> = { slack: readSlackManagedInstall };

/** The managed app this checkout installed on `platform`, or null when there is none. */
export async function managedInstall(
  platform: string,
  { root = process.cwd() }: ManagedInstallOptions = {},
): Promise<ManagedInstall | null> {
  const read = readers[platform];
  if (!read) return null;
  const install = await read(root);
  return install ? { platform, ...install } : null;
}

/** Install + bearer, or null when either half is missing. */
export async function managedInstallCredentials(
  platform: string,
  { root = process.cwd(), homeDir }: ManagedInstallOptions = {},
): Promise<ManagedInstallCredentials | null> {
  const install = await managedInstall(platform, { root });
  if (!install) return null;
  const identity = await readInstallIdentity(homeDir ? { homeDir } : {});
  if (!identity) return null;
  return { ...install, token: identity.token };
}
