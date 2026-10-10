import { readFileSync } from 'node:fs';

// Setup already requires Node. Keep these two API checks independent of jq,
// which is not installed by NanoClaw's public bootstrap.
const [kind, baseUrl] = process.argv.slice(2);
try {
  const response = JSON.parse(readFileSync(0, 'utf8'));
  if (kind === 'config') {
    if (!baseUrl || response.SiteURL !== baseUrl || (response.WebsocketURL ?? '') !== '') {
      throw new Error('Server configuration mismatch');
    }
    process.stdout.write(`${response.SiteURL}\n\n`);
  } else if (kind === 'dm') {
    if (typeof response.id !== 'string' || !/^[a-z0-9]{26}$/.test(response.id) || response.type !== 'D') {
      throw new Error('Invalid direct channel');
    }
    process.stdout.write(`mattermost:${response.id}\n`);
  } else {
    throw new Error('Unknown response kind');
  }
} catch {
  // API error bodies can contain private data; never echo them on failure.
  console.error('Could not verify the Mattermost server configuration or owner DM response.');
  process.exitCode = 1;
}
