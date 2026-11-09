import { installGateway } from './install.js';
import { detectInstalledGateway } from './selection.js';
import { emitStatus } from '../status.js';

export async function run(args: string[]): Promise<void> {
  const selected = args[0]?.trim().toLowerCase() || detectInstalledGateway(process.cwd());
  const entry = await installGateway(selected);
  // Every step runner reports through one terminal status block (docs/setup-flow.md);
  // headless drivers treat a silent zero exit as an incomplete step.
  emitStatus('GATEWAY', { STATUS: 'success', GATEWAY: entry.kind });
}
