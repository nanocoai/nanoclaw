import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildScriptOutput,
  serializeScriptLine,
} from './build-script-output.js';
import { fetchHn } from './fetch-hn.js';
import { fetchAllRss } from './fetch-rss.js';
import { dedupeByUrl } from './normalize.js';
import { filterWithinWindow } from './time-window.js';
import type { FeedsConfig } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function loadConfig(): FeedsConfig {
  const raw = readFileSync(join(ROOT, 'config/feeds.json'), 'utf8');
  return JSON.parse(raw) as FeedsConfig;
}

function resolveTimezone(): string {
  return process.env.TZ || 'Asia/Shanghai';
}

export async function runFetch(now = new Date()): Promise<string> {
  const config = loadConfig();
  const timezone = resolveTimezone();
  const errors: Array<{ source: string; message: string }> = [];

  const hn = await fetchHn({ topStories: config.hn.topStories });
  errors.push(...hn.errors);

  const rss = await fetchAllRss(config.feeds);
  errors.push(...rss.errors);

  const merged = dedupeByUrl([...hn.items, ...rss.items]);
  const inWindow = filterWithinWindow(merged, config.windowHours, now);
  const result = buildScriptOutput(
    inWindow,
    errors,
    timezone,
    config.windowHours,
    now,
  );

  return serializeScriptLine(result);
}

async function main(): Promise<void> {
  const line = await runFetch();
  console.log(line);
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
