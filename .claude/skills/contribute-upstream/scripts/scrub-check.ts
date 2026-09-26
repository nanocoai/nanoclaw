import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { DEFAULTS } from './config.js';

export interface ScrubRule {
  readonly name: string;
  readonly pattern: RegExp;
}

export interface ScrubFinding {
  readonly source: string;
  readonly line: number;
  readonly rule: string;
  readonly match: string;
}

const ALLOWED_MATCHES: readonly RegExp[] = [
  /^noreply@anthropic\.com$/i,
  /@example\.(com|org|net)$/i,
  /^\/home\/node\b/,
];

export const BUILTIN_RULES: readonly ScrubRule[] = [
  {
    name: 'private-ip',
    pattern:
      /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
  },
  { name: 'home-path', pattern: /\/(?:Users|home)\/[A-Za-z0-9._-]+/g },
  { name: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { name: 'internal-host', pattern: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|corp|intranet|lan)\b/gi },
  { name: 'anthropic-or-openai-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { name: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'telegram-bot-token', pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
];

const REGEX_ENTRY = /^\/(.+)\/([a-z]*)$/;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseDenylist(content: string): ScrubRule[] {
  const rules: ScrubRule[] = [];
  for (const raw of content.split('\n')) {
    const entry = raw.trim();
    if (!entry || entry.startsWith('#')) {
      continue;
    }
    const regexEntry = REGEX_ENTRY.exec(entry);
    if (regexEntry) {
      const flags = new Set([...regexEntry[2], 'g']);
      rules.push({ name: `denylist:${entry}`, pattern: new RegExp(regexEntry[1], [...flags].join('')) });
      continue;
    }
    rules.push({ name: `denylist:${entry}`, pattern: new RegExp(escapeRegex(entry), 'gi') });
  }
  return rules;
}

function isAllowed(match: string): boolean {
  return ALLOWED_MATCHES.some((allowed) => allowed.test(match));
}

export function scanText(source: string, text: string, rules: readonly ScrubRule[]): ScrubFinding[] {
  const findings: ScrubFinding[] = [];
  text.split('\n').forEach((lineText, index) => {
    for (const rule of rules) {
      for (const found of lineText.matchAll(rule.pattern)) {
        if (isAllowed(found[0])) {
          continue;
        }
        findings.push({ source, line: index + 1, rule: rule.name, match: found[0] });
      }
    }
  });
  return findings;
}

export function addedLinesByFile(unifiedDiff: string): Map<string, string> {
  const added = new Map<string, string[]>();
  let currentFile = '';
  for (const line of unifiedDiff.split('\n')) {
    if (line.startsWith('+++ ')) {
      currentFile = line.replace(/^\+\+\+ (b\/)?/, '');
      continue;
    }
    if (!currentFile || currentFile === '/dev/null' || !line.startsWith('+')) {
      continue;
    }
    const lines = added.get(currentFile) ?? [];
    lines.push(line.slice(1));
    added.set(currentFile, lines);
  }
  return new Map([...added].map(([file, lines]) => [file, lines.join('\n')]));
}

export function maskMatch(match: string): string {
  if (match.length <= 4) {
    return '*'.repeat(match.length);
  }
  return `${match.slice(0, 2)}${'*'.repeat(match.length - 4)}${match.slice(-2)}`;
}

interface CliOptions {
  readonly denylistPath: string;
  readonly diffBase?: string;
  readonly allowedIdentities: string[];
  readonly paths: string[];
}

function parseArgs(argv: readonly string[]): CliOptions {
  const paths: string[] = [];
  let denylistPath: string = DEFAULTS.denylist;
  let diffBase: string | undefined;
  const allowedIdentities: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--denylist') {
      denylistPath = argv[++i];
    } else if (argv[i] === '--diff') {
      diffBase = argv[++i];
    } else if (argv[i] === '--allow-identity') {
      allowedIdentities.push(argv[++i]);
    } else {
      paths.push(argv[i]);
    }
  }
  return { denylistPath, diffBase, allowedIdentities, paths };
}

function git(args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function collectSources(options: CliOptions): Map<string, string> {
  const sources = new Map<string, string>();
  if (options.diffBase) {
    for (const [file, text] of addedLinesByFile(git(['diff', '--unified=0', `${options.diffBase}...HEAD`]))) {
      sources.set(file, text);
    }
    sources.set('(commit messages)', git(['log', `${options.diffBase}..HEAD`, '--format=%B']));
    sources.set('(branch name)', git(['rev-parse', '--abbrev-ref', 'HEAD']));
  }
  for (const path of options.paths) {
    sources.set(path, readFileSync(path, 'utf8'));
  }
  return sources;
}

export function unapprovedIdentities(identityLines: string, allowedEmails: readonly string[]): string {
  const allowed = new Set(allowedEmails.map((email) => email.toLowerCase()));
  return identityLines
    .split('\n')
    .map((line) => (allowed.has(/<([^>]*)>$/.exec(line)?.[1]?.toLowerCase() ?? '') ? '' : line))
    .join('\n');
}

function commitIdentities(diffBase: string): string {
  return git(['log', `${diffBase}..HEAD`, '--format=%an <%ae>%n%cn <%ce>']);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!options.diffBase && options.paths.length === 0) {
    console.error(
      'usage: scrub-check.ts [--denylist <file>] [--diff <base-ref>] [--allow-identity <email>]... [paths...]',
    );
    process.exit(2);
  }
  const denylist = existsSync(options.denylistPath) ? parseDenylist(readFileSync(options.denylistPath, 'utf8')) : [];
  if (denylist.length === 0) {
    console.error(`warning: denylist ${options.denylistPath} is missing or empty — only built-in rules apply`);
  }
  const rules = [...BUILTIN_RULES, ...denylist];
  const findings = [...collectSources(options)].flatMap(([source, text]) => scanText(source, text, rules));
  if (options.diffBase) {
    const identities = unapprovedIdentities(commitIdentities(options.diffBase), options.allowedIdentities);
    findings.push(...scanText('(commit authors)', identities, denylist));
  }
  for (const finding of findings) {
    console.log(`${finding.source}:${finding.line}  ${finding.rule}  ${maskMatch(finding.match)}`);
  }
  console.log(findings.length === 0 ? 'scrub-check: clean' : `scrub-check: ${findings.length} finding(s)`);
  process.exit(findings.length === 0 ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
