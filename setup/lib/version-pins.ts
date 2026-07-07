/**
 * Sanctioned version pins for external components (`versions.json` at the
 * repo root) — the single machine-checkable source. Setup steps read their
 * pin here; `/update-nanoclaw` diffs the file across an update and routes
 * the user to the migration doc for any pin that moved (see CONTRIBUTING.md,
 * "Breaking changes").
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const VERSIONS_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'versions.json',
);

/**
 * Returns the pinned version for a component, e.g.
 * `readVersionPin('onecli-gateway')`. Throws when the file or the pin is
 * missing — a missing pin is an install-tree defect, not a runtime condition.
 */
export function readVersionPin(component: string): string {
  const pins: unknown = JSON.parse(fs.readFileSync(VERSIONS_FILE, 'utf-8'));
  const value = (pins as Record<string, unknown>)[component];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`versions.json has no pin for "${component}"`);
  }
  return value;
}
