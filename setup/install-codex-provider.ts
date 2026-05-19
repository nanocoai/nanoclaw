import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const FILES = [
  'src/providers/codex.ts',
  'container/agent-runner/src/providers/codex.ts',
  'container/agent-runner/src/providers/codex-app-server.ts',
  'container/agent-runner/src/providers/codex.factory.test.ts',
];

const REMOTES = ['origin', 'upstream'];

let providerRef: string | null = null;

function hasCodexProvider(): boolean {
  return (
    FILES.every((f) => fs.existsSync(path.resolve(f))) &&
    fs.readFileSync('src/providers/index.ts', 'utf-8').includes("import './codex.js';") &&
    fs.readFileSync('container/agent-runner/src/providers/index.ts', 'utf-8').includes("import './codex.js';") &&
    fs.readFileSync('container/Dockerfile', 'utf-8').includes('@openai/codex@')
  );
}

function gitShow(file: string): string {
  if (!providerRef) throw new Error('providers branch was not resolved');
  return execFileSync('git', ['show', `${providerRef}:${file}`], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function ensureProvidersBranch(): void {
  for (const remote of REMOTES) {
    const ref = `${remote}/providers`;
    try {
      execFileSync('git', ['rev-parse', '--verify', ref], { stdio: 'ignore' });
      providerRef = ref;
      return;
    } catch {
      // Try the next source.
    }
  }

  for (const remote of REMOTES) {
    try {
      execFileSync('git', ['remote', 'get-url', remote], { stdio: 'ignore' });
      execFileSync('git', ['fetch', remote, 'providers'], { stdio: 'inherit' });
      providerRef = `${remote}/providers`;
      return;
    } catch {
      // Try the next remote.
    }
  }

  throw new Error('Could not fetch a providers branch from origin or upstream');
}

function writeProviderFiles(): void {
  for (const file of FILES) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, gitShow(file));
  }
}

function ensureImport(file: string): void {
  const line = "import './codex.js';";
  const raw = fs.readFileSync(file, 'utf-8');
  if (raw.includes(line)) return;
  fs.writeFileSync(file, `${raw.trimEnd()}\n${line}\n`);
}

function ensureDockerfile(): void {
  const file = 'container/Dockerfile';
  let raw = fs.readFileSync(file, 'utf-8');
  if (!raw.includes('ARG CODEX_VERSION=')) {
    raw = raw.replace(/(ARG CLAUDE_CODE_VERSION=.*\n)/, `$1ARG CODEX_VERSION=0.124.0\n`);
  }
  if (!raw.includes('@openai/codex@${CODEX_VERSION}')) {
    raw = raw.replace(
      /(RUN --mount=type=cache,target=\/root\/\.cache\/pnpm\s+\\\n\s+pnpm install -g "@anthropic-ai\/claude-code@\$\{CLAUDE_CODE_VERSION\}"\n)/,
      `$1\nRUN --mount=type=cache,target=/root/.cache/pnpm \\\n    pnpm install -g "@openai/codex@\${CODEX_VERSION}"\n`,
    );
  }
  fs.writeFileSync(file, raw);
}

function main(): void {
  if (hasCodexProvider()) {
    console.log('Codex provider already installed.');
    return;
  }
  ensureProvidersBranch();
  writeProviderFiles();
  ensureImport('src/providers/index.ts');
  ensureImport('container/agent-runner/src/providers/index.ts');
  ensureDockerfile();
  if (!hasCodexProvider()) {
    throw new Error('Codex provider install did not leave all required files wired');
  }
  console.log('Codex provider installed.');
}

main();
