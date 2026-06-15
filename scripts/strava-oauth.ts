/**
 * One-time Strava OAuth flow.
 *
 * Creates a Strava API app at https://www.strava.com/settings/api, then run:
 *   pnpm exec tsx scripts/strava-oauth.ts <client_id> <client_secret>
 *
 * Opens a browser for authorization, captures the callback, exchanges for
 * tokens, and saves them to data/strava-tokens.json.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { exec } from 'child_process';

const REDIRECT_PORT = 9876;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const TOKEN_PATH = path.join(process.cwd(), 'data', 'strava-tokens.json');

const clientId = process.argv[2];
const clientSecret = process.argv[3];

if (!clientId || !clientSecret) {
  console.error('Usage: pnpm exec tsx scripts/strava-oauth.ts <client_id> <client_secret>');
  console.error('\nCreate a Strava API app at https://www.strava.com/settings/api');
  console.error('Set Authorization Callback Domain to: localhost');
  process.exit(1);
}

const authUrl =
  `https://www.strava.com/oauth/authorize?client_id=${clientId}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code&approval_prompt=auto` +
  `&scope=read,read_all,activity:read,activity:read_all,profile:read_all`;

console.log('\nOpening browser for Strava authorization...');
console.log(`If the browser doesn't open, visit:\n${authUrl}\n`);

const openCmd =
  process.platform === 'darwin'
    ? `open "${authUrl}"`
    : process.platform === 'win32'
      ? `start "${authUrl}"`
      : `xdg-open "${authUrl}" 2>/dev/null || sensible-browser "${authUrl}" 2>/dev/null || echo "Open this URL in your browser: ${authUrl}"`;
exec(openCmd);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:${REDIRECT_PORT}`);

  if (url.pathname !== '/callback') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error || !code) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<h1>Authorization failed</h1><p>You can close this tab.</p>');
    console.error('Authorization failed:', error || 'no code received');
    process.exit(1);
  }

  try {
    const tokenRes = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      throw new Error(`Token exchange failed (${tokenRes.status}): ${body}`);
    }

    const data = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      expires_at: number;
      athlete: { id: number; firstname: string; lastname: string };
    };

    const tokens = {
      client_id: clientId,
      client_secret: clientSecret,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
      athlete_id: data.athlete.id,
      athlete_name: `${data.athlete.firstname} ${data.athlete.lastname}`,
      updated_at: new Date().toISOString(),
    };

    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2) + '\n');
    console.log(`\nTokens saved to ${TOKEN_PATH}`);
    console.log(`Athlete: ${tokens.athlete_name} (ID: ${tokens.athlete_id})`);
    console.log(`Access token expires: ${new Date(data.expires_at * 1000).toISOString()}`);

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      `<h1>Strava connected!</h1>` +
        `<p>Athlete: ${tokens.athlete_name}</p>` +
        `<p>You can close this tab.</p>`,
    );
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end('<h1>Token exchange failed</h1><p>Check the terminal for details.</p>');
    console.error('Token exchange error:', err);
    process.exit(1);
  }

  server.close();
  process.exit(0);
});

server.listen(REDIRECT_PORT, () => {
  console.log(`Waiting for callback on port ${REDIRECT_PORT}...`);
});

setTimeout(() => {
  console.error('\nTimeout: no callback received after 2 minutes.');
  server.close();
  process.exit(1);
}, 120_000);
