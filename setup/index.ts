/**
 * Setup CLI entry point.
 * Usage: pnpm exec tsx setup/index.ts --step <name> [args...]
 */
import { log } from '../src/log.js';
import { emitStatus } from './status.js';

const STEPS: Record<
  string,
  () => Promise<{ run: (args: string[]) => Promise<void> }>
> = {
  timezone: () => import('./timezone.js'),
  'set-env': () => import('./set-env.js'),
  environment: () => import('./environment.js'),
  container: () => import('./container.js'),
  register: () => import('./register.js'),
  'pair-telegram': () => import('./pair-telegram.js'),
  groups: () => import('./groups.js'),
  'whatsapp-auth': () => import('./whatsapp-auth.js'),
  'signal-auth': () => import('./signal-auth.js'),
  mounts: () => import('./mounts.js'),
  service: () => import('./service.js'),
  verify: () => import('./verify.js'),
  onecli: () => import('./onecli.js'),
  auth: () => import('./auth.js'),
  'provider-auth': () => import('./provider-auth.js'),
  'cli-agent': () => import('./cli-agent.js'),
  // >>> nanoclaw:setup-steps
  // <<< nanoclaw:setup-steps
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stepIdx = args.indexOf('--step');

  if (stepIdx === -1 || !args[stepIdx + 1]) {
    console.error(
      `Usage: pnpm exec tsx setup/index.ts --step <${Object.keys(STEPS).join('|')}> [args...]`,
    );
    process.exit(1);
  }

  const stepName = args[stepIdx + 1];
  const stepArgs = args.filter(
    (a, i) => i !== stepIdx && i !== stepIdx + 1 && a !== '--',
  );

  const loader = STEPS[stepName];
  if (!loader) {
    console.error(`Unknown step: ${stepName}`);
    console.error(`Available steps: ${Object.keys(STEPS).join(', ')}`);
    process.exit(1);
  }

  try {
    const mod = await loader();
    await mod.run(stepArgs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Setup step failed', { err, step: stepName });
    emitStatus(stepName.toUpperCase(), {
      STATUS: 'failed',
      ERROR: message,
    });
    process.exit(1);
  }
}

main();
