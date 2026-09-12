import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { envValue } from '../../../../src/env.js';
import { upsertEnvVar } from '../../../../setup/set-env.js';

const urlShape =
  /^https?:\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~%+-]+)*$/;

export async function configure(
  baseUrl: string,
  botToken: string,
  callbackUrl: string,
): Promise<{ id: string; username: string }> {
  // Validate before the first write, including direct helper invocations. The
  // helper also owns authentication, so a failed earlier skill step can never
  // cause an unverified replacement credential to be persisted.
  for (const [label, value] of [
    ['base URL', baseUrl],
    ['callback URL', callbackUrl],
  ]) {
    if (!urlShape.test(value)) throw new Error(`Invalid Mattermost ${label}`);
    new URL(value); // also rejects invalid ports / IPv6 literals
  }
  if (!/^[A-Za-z0-9_-]{20,}$/.test(botToken)) throw new Error('Invalid Mattermost bot token');

  const response = await fetch(`${baseUrl}/api/v4/users/me`, {
    headers: { Authorization: `Bearer ${botToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('Mattermost rejected the bot token');
  const user = (await response.json()) as { id?: unknown; username?: unknown; is_bot?: unknown };
  if (
    typeof user.id !== 'string' ||
    !/^[a-z0-9]{26}$/.test(user.id) ||
    typeof user.username !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(user.username) ||
    user.is_bot !== true
  ) {
    throw new Error('Mattermost did not return a valid bot account');
  }

  // Existing cards carry this secret. Rerunning setup must not invalidate them.
  // Generate it here so it never becomes a public skill capture or result var.
  const secret = envValue('MATTERMOST_CALLBACK_SECRET') ?? randomBytes(32).toString('hex');
  upsertEnvVar('MATTERMOST_BASE_URL', baseUrl);
  upsertEnvVar('MATTERMOST_BOT_TOKEN', botToken);
  upsertEnvVar('MATTERMOST_CALLBACK_URL', callbackUrl);
  upsertEnvVar('MATTERMOST_CALLBACK_SECRET', secret);
  return { id: user.id, username: user.username };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [baseUrl = '', botToken = '', callbackUrl = ''] = process.argv.slice(2);
    const identity = await configure(baseUrl, botToken, callbackUrl);
    console.log(JSON.stringify(identity));
  } catch {
    console.error(
      'Could not authenticate and save Mattermost settings. Check server reachability, URLs, and the bot token.',
    );
    process.exitCode = 1;
  }
}
