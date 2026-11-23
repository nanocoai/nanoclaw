// The channels branch keeps its own package.json and lockfile for the adapters
// it ships, and nothing ties them to the versions skills on main pin. This
// compares the two, so the channels tests run the adapter users get (#4552).
//
//   pnpm run skill-pins:channels [ref]   ref defaults to origin/channels

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

import { GENERATE, NpmPin, collect, groupPins } from './skill-pins.js';

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

type Manifest = Partial<Record<(typeof SECTIONS)[number], Record<string, string>>>;
type Lockfile = {
  importers?: Record<string, Partial<Record<(typeof SECTIONS)[number], Record<string, { version?: string }>>>>;
};

/** A pin `nc:dep` writes into the host package.json (no cwd, or cwd `.`). */
function hostPin(pin: NpmPin): boolean {
  if (pin.via !== 'nc:dep') return false;
  const cwd = pin.detail.match(/(?:^| )cwd:(\S+)/)?.[1];
  return cwd === undefined || cwd === '.' || cwd === './';
}

/** The version pnpm installed: `0.1.1(chat@4.41.1)(...)` -> `0.1.1`. */
function resolved(lock: Lockfile, name: string): string | undefined {
  const root = lock.importers?.['.'];
  for (const section of SECTIONS) {
    const version = root?.[section]?.[name]?.version;
    if (version) return version.replace(/\(.*$/, '');
  }
  return undefined;
}

/**
 * Packages both channels' package.json and a host skill pin list, where the
 * version channels' lockfile installs is not the pin. Packages channels does
 * not list are fine: the skill adds them on install.
 */
export function channelsPinProblems(pins: Map<string, NpmPin[]>, pkg: Manifest, lock: Lockfile, ref: string): string[] {
  const problems: string[] = [];
  for (const [name, list] of [...pins].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const host = list.filter(hostPin);
    if (!host.length) continue;
    const spec = SECTIONS.map((s) => pkg[s]?.[name]).find((v) => v !== undefined);
    if (spec === undefined) continue;
    const want = host[0].version;
    const got = resolved(lock, name);
    if (got === want) continue;
    const at = host.map((p) => `${p.file}:${p.line}`).join(', ');
    problems.push(`${name}: ${ref} has "${spec}" (lockfile: ${got ?? 'missing'}), the skills pin ${want} (${at})`);
  }
  return problems;
}

export function report(problems: string[], ref: string): { ok: boolean; message: string } {
  if (!problems.length) return { ok: true, message: `${ref} package.json matches the skill pins.` };
  return {
    ok: false,
    message: [
      `${ref} installs different versions than the skills pin:`,
      ...problems.map((p) => `  ${p}`),
      'Fix: in a PR to channels, set each package to the pinned version in package.json, run',
      '`pnpm install`, and commit package.json and pnpm-lock.yaml (rename any patches/ file named',
      `for the old version). If channels is right instead, change the pin in the skill and run \`${GENERATE}\`.`,
    ].join('\n'),
  };
}

const show = (root: string, ref: string, file: string) =>
  execFileSync('git', ['show', `${ref}:${file}`], { cwd: root, encoding: 'utf8' });

export function checkChannels(root: string, ref: string): { ok: boolean; message: string } {
  const { pins, problems } = groupPins(collect(root));
  // skill-pins:check reports these in full; a package pinned twice has no one version to compare.
  if (problems.length) return { ok: false, message: `Skill pins have problems; run \`pnpm run skill-pins:check\`.` };
  const pkg = JSON.parse(show(root, ref, 'package.json')) as Manifest;
  const lock = parse(show(root, ref, 'pnpm-lock.yaml')) as Lockfile;
  return report(channelsPinProblems(pins, pkg, lock, ref), ref);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkChannels(process.cwd(), process.argv[2] ?? 'origin/channels');
  (result.ok ? console.log : console.error)(result.message);
  process.exitCode = result.ok ? 0 : 1;
}
