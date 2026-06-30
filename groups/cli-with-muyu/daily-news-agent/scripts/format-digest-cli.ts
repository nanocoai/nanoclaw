import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatDigestFromCliInput,
  parseDigestCliInput,
} from '../lib/format-digest-cli.js';

async function main(): Promise<void> {
  const raw = readFileSync(0, 'utf8');
  const input = parseDigestCliInput(raw);
  process.stdout.write(formatDigestFromCliInput(input));
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
