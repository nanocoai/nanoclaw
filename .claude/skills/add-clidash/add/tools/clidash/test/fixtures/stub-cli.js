#!/usr/bin/env node
// Stub CLI for clidash tests. Impersonates ncl (envelope json) or a
// jsonlines CLI, with failure/slowness/garbage modes driven by env vars.
import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);

if (process.env.STUB_COUNT_FILE) {
  appendFileSync(process.env.STUB_COUNT_FILE, args.join(' ') + '\n');
}

const sleepMs = Number(process.env.STUB_SLEEP_MS || 0);

setTimeout(() => {
  if (process.env.STUB_FAIL) {
    process.stderr.write('boom: socket down\n');
    process.exit(2);
  }
  if (args[0] === 'help') {
    process.stdout.write(
      readFileSync(fileURLToPath(new URL('./ncl-help.txt', import.meta.url)), 'utf8'),
    );
    process.exit(0);
  }
  if (args[1] === 'help') { // `<resource> help` → raw per-resource help text
    process.stdout.write(`${args[0]}: help for ${args[0]}\n\nVerbs:\n  list\n  get <id>\n`);
    process.exit(0);
  }
  if (process.env.STUB_RAW) {
    process.stdout.write(process.env.STUB_RAW + '\n');
    process.exit(0);
  }
  const resource = args[0];
  // `get`/detail commands → single-object envelope
  if (args.includes('get') || args.includes('config')) {
    process.stdout.write(JSON.stringify({
      id: 'req-1', ok: true,
      data: { id: `${resource}-detail`, args: args.join(' '), extra: 'field' },
    }) + '\n');
    process.exit(0);
  }
  if (process.env.STUB_JSONLINES) {
    process.stdout.write(JSON.stringify({ id: `${resource}-1`, name: 'row one' }) + '\n');
    process.stdout.write(JSON.stringify({ id: `${resource}-2`, name: 'row two' }) + '\n');
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    id: 'req-1',
    ok: true,
    data: [
      { id: `${resource}-1`, name: 'row one' },
      { id: `${resource}-2`, name: 'row two' },
    ],
  }) + '\n');
  process.exit(0);
}, sleepMs);
