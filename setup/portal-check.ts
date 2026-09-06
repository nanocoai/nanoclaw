import fs from 'node:fs/promises';
import path from 'node:path';

// Read the delivered fixture from this checkout. Never print a credential or
// accept a real partner token through a CLI argument/environment variable.
const perk = process.argv[2];
if (!['tavily', 'dial'].includes(perk)) {
  console.log('Usage: pnpm exec tsx setup/portal-check.ts tavily|dial');
  process.exit(perk === '--help' ? 0 : 1);
}
try {
  const saved = JSON.parse(await fs.readFile(path.join(process.cwd(), 'data/community-portal.json'), 'utf8'));
  const secret = saved.credentials?.[perk]?.secret;
  if (typeof secret !== 'string' || !secret.startsWith(`nc_sim_${perk}_`)) throw new Error(`Activate ${perk} in the hosted test portal and return to the terminal first.`);
  const origin = new URL(saved.origin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('The saved portal origin must use HTTPS.');
  const response = await fetch(`${origin.origin}/api/v1/simulators/${perk}/use`, {
    method: 'POST', headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(15000), redirect: 'error',
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || 'The simulator rejected this credential.');
  if (result.simulated !== true || result.provider !== perk) throw new Error('The endpoint did not confirm a simulated result.');
  console.log(JSON.stringify({ simulated: true, provider: perk, resource: result.resource, result: result.result }, null, 2));
} catch (error) {
  console.error(error instanceof SyntaxError ? 'The saved setup state or simulator response is invalid.'
    : error instanceof Error && 'code' in error && error.code === 'ENOENT'
    ? 'Run NanoClaw setup and activate a test perk first.'
    : error instanceof Error ? error.message : 'Could not check the test perk.');
  process.exitCode = 1;
}
