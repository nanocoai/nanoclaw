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
type Section = (typeof SECTIONS)[number];

type Manifest = Partial<Record<(typeof SECTIONS)[number], Record<string, string>>>;
type Lockfile = {
  importers?: Record<
    string,
    Partial<Record<(typeof SECTIONS)[number], Record<string, { specifier?: string; version?: string }>>>
  >;
};

/** A pin `nc:dep` writes into the host package.json (no cwd, or cwd `.`). */
function hostPin(pin: NpmPin): boolean {
  if (pin.via !== 'nc:dep') return false;
  const cwd = pin.detail.match(/(?:^| )cwd:(\S+)/)?.[1];
  return cwd === undefined || cwd === '.' || cwd === './';
}

/** The lockfile's entry in the same section: the specifier it was made from, and the version installed. */
function locked(lock: Lockfile, section: Section, name: string): { specifier?: string; version?: string } {
  const entry = lock.importers?.['.']?.[section]?.[name];
  // `0.1.1(chat@4.41.1)(...)` -> `0.1.1`
  return { specifier: entry?.specifier, version: entry?.version?.replace(/\(.*$/, '') };
}

/**
 * Packages both channels' package.json and a host skill pin list, where
 * package.json is not exactly the pin (a range drifts once a newer version is
 * out), the lockfile installs another version, or the lockfile was made from
 * another specifier (stale). Packages channels does not list are fine: the
 * skill adds them on install.
 */
export function channelsPinProblems(pins: Map<string, NpmPin[]>, pkg: Manifest, lock: Lockfile, ref: string): string[] {
  const problems: string[] = [];
  for (const [name, list] of [...pins].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const host = list.filter(hostPin);
    if (!host.length) continue;
    const section = SECTIONS.find((s) => pkg[s]?.[name] !== undefined);
    if (section === undefined) continue;
    const spec = pkg[section]![name];
    const want = host[0].version;
    const { specifier, version } = locked(lock, section, name);
    if (spec === want && version === want && specifier === spec) continue;
    const at = host.map((p) => `${p.file}:${p.line}`).join(', ');
    const lockText = version ? `lockfile: "${specifier ?? '?'}" -> ${version}` : 'not in the lockfile';
    problems.push(`${name}: ${ref} has "${spec}" (${lockText}), the skills pin ${want} (${at})`);
  }
  return problems;
}

export function report(problems: string[], ref: string): { ok: boolean; message: string } {
  if (!problems.length) return { ok: true, message: `${ref} package.json matches the skill pins.` };
  return {
    ok: false,
    message: [
      `${ref} package.json or pnpm-lock.yaml does not match the skill pins:`,
      ...problems.map((p) => `  ${p}`),
      'Fix: if this change moved a skill pin, open a PR to channels with the same version, link it',
      'here, and merge that one first. Otherwise channels drifted on its own: fix it in a PR to channels.',
      'In that PR, set package.json to the exact pinned version (no ^ or ~). If the package has a patch,',
      'rename its patches/ file and update its pnpm.patchedDependencies key and path to match. Then run',
      '`pnpm install` and commit package.json, pnpm-lock.yaml and patches/. If package.json is already',
      'exact and only the lockfile specifier differs, the lockfile is stale: `pnpm install` alone fixes it.',
      `If channels is right instead, change the pin in the skill and run \`${GENERATE}\`.`,
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
