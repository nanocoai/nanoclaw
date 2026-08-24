import { getLaunchdLabel, getSystemdUnit } from '../install-slug.js';

export function formatTransportError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('ENOENT') || msg.includes('ECONNREFUSED')) {
    // `bin/ncl` cd's to the project root before exec'ing client.ts, so
    // process.cwd() is the install dir — install-slug helpers pick up
    // the right per-checkout suffix.
    return [
      `ncl: cannot reach NanoClaw host (${msg}).`,
      `Is the host running? Start it with: pnpm run dev`,
      `Or, if installed as a service:`,
      `  macOS:  launchctl kickstart -k gui/$(id -u)/${getLaunchdLabel()}`,
      `  Linux:  systemctl --user restart ${getSystemdUnit()}`,
      ``,
    ].join('\n');
  }
  return `ncl: transport error: ${msg}\n`;
}
