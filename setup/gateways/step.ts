import { installGateway } from './install.js';
import { detectInstalledGateway } from './selection.js';

export async function run(args: string[]): Promise<void> {
  const selected = args[0]?.trim().toLowerCase() || detectInstalledGateway(process.cwd());
  await installGateway(selected);
}
