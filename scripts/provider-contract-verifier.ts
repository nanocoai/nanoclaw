import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ProviderContractVerification {
  status: 'passed' | 'failed' | 'skipped';
  checks: string[];
  error?: string;
}

export interface ProviderContractVerifierOptions {
  commandAvailable?: (command: string, cwd: string) => boolean;
  exec?: (command: string, cwd: string) => string | void | Promise<string | void>;
  expectedLegacyProviders?: string[];
  requiredDeclaredProviders?: string[];
}

function commandAvailable(command: string, cwd: string): boolean {
  try {
    const version = execFileSync(command, ['--version'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return command !== 'bun' || isPinnedBunVersion(cwd, version.trim());
  } catch {
    return false;
  }
}

export function pinnedBunVersion(root: string): string {
  const dockerfile = fs.readFileSync(path.join(root, 'container/Dockerfile'), 'utf8');
  const match = dockerfile.match(/^ARG BUN_VERSION=([^\s#]+)$/m);
  if (!match) throw new Error('container/Dockerfile does not declare an exact BUN_VERSION');
  return match[1];
}

export function isPinnedBunVersion(root: string, version: string): boolean {
  return version === pinnedBunVersion(root);
}

/** Where a provider's runtime conformance test lives, relative to the install root. */
export function runtimeConformanceTestPath(provider: string): string {
  return `container/agent-runner/src/providers/${provider}.conformance.test.ts`;
}

export async function verifyProviderContracts(
  root: string,
  options: ProviderContractVerifierOptions = {},
): Promise<ProviderContractVerification> {
  if (!fs.existsSync(path.join(root, 'src/provider-contracts/index.ts'))) {
    return { status: 'skipped', checks: [] };
  }

  const checks: string[] = [];
  const run = async (name: string, command: string, cwd = root): Promise<string> => {
    const output = options.exec
      ? await options.exec(command, cwd)
      : execSync(command, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    checks.push(name);
    return String(output ?? '').trim();
  };

  try {
    const bun = (options.commandAvailable ?? commandAvailable)('bun', root)
      ? 'bun'
      : `pnpm --package=bun@${pinnedBunVersion(root)} dlx bun`;
    const runnerRoot = path.join(root, 'container/agent-runner');

    await run('host dependencies', 'pnpm install --frozen-lockfile');
    await run('runtime dependencies', `${bun} install --frozen-lockfile`, runnerRoot);
    await run('host build', 'pnpm run build');
    const optionalHostTests = fs.existsSync(path.join(root, 'src/opencode-cli-tools.test.ts'))
      ? ' src/opencode-cli-tools.test.ts'
      : '';
    await run(
      'host provider contract tests',
      `pnpm exec vitest run src/provider-contracts src/providers setup/provider-contract.test.ts setup/providers${optionalHostTests}`,
    );
    await run('runtime typecheck', 'pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit');
    await run('runtime provider contract tests', `${bun} test src/provider-contracts src/providers`, runnerRoot);

    const host = JSON.parse(
      await run('host contract inventory', 'pnpm exec tsx scripts/provider-contract-names.ts'),
    ) as {
      host: string[];
      hostProviders: string[];
      setupProviders: string[];
    };
    const runtime = JSON.parse(
      await run('runtime contract inventory', `${bun} src/provider-contracts/names.ts`, runnerRoot),
    ) as { contracts: string[]; providers: string[] };
    const expected = JSON.stringify(host.host);
    if (JSON.stringify(runtime.contracts) !== expected) {
      throw new Error(
        `Provider contract inventories differ: host=${expected}, runtime=${JSON.stringify(runtime.contracts)}`,
      );
    }
    // Every declared runtime contract proves itself from its own
    // providers/<name>.conformance.test.ts — the probe fixtures a contract
    // needs are provider knowledge, so core runs no generic sweep. The
    // 'runtime provider contract tests' step above (`bun test
    // src/provider-contracts src/providers`) already executed the file;
    // this check is what makes a payload that forgot to ship it fail.
    for (const provider of runtime.contracts) {
      const relative = runtimeConformanceTestPath(provider);
      if (!fs.existsSync(path.join(root, relative))) {
        throw new Error(`Provider '${provider}' declares a runtime contract but ships no ${relative}`);
      }
    }
    checks.push('runtime conformance test files');
    const contracts = new Set(host.host);
    const registered = new Set([...host.hostProviders, ...host.setupProviders, ...runtime.providers]);
    const undeclared = [...registered].filter((provider) => !contracts.has(provider)).sort();
    const requiredDeclared = [...new Set(options.requiredDeclaredProviders ?? [])].sort();
    const missingRequired = requiredDeclared.filter((provider) => !contracts.has(provider));
    if (missingRequired.length) {
      throw new Error(`Required provider contracts missing: ${missingRequired.join(', ')}`);
    }
    const expectedLegacy = options.requiredDeclaredProviders
      ? undeclared
      : [...new Set(options.expectedLegacyProviders ?? [])].sort();
    if (JSON.stringify(undeclared) !== JSON.stringify(expectedLegacy)) {
      throw new Error(
        `Undeclared legacy providers differ: expected=${JSON.stringify(expectedLegacy)}, actual=${JSON.stringify(undeclared)}`,
      );
    }

    const expectedRuntime = [...new Set([...host.host, ...expectedLegacy])].sort();
    if (JSON.stringify(runtime.providers) !== JSON.stringify(expectedRuntime)) {
      throw new Error(
        `Runtime provider surface differs: expected=${JSON.stringify(expectedRuntime)}, actual=${JSON.stringify(runtime.providers)}`,
      );
    }
    const missingLegacyHost = expectedLegacy.filter((provider) => !host.hostProviders.includes(provider));
    if (missingLegacyHost.length) {
      throw new Error(`Legacy provider host surface missing: ${missingLegacyHost.join(', ')}`);
    }

    return { status: 'passed', checks };
  } catch (error) {
    return { status: 'failed', checks, error: error instanceof Error ? error.message : String(error) };
  }
}

export function parseProviderContractVerifierArgs(argv: string[]): ProviderContractVerifierOptions {
  if (argv.length === 0) return {};
  if (argv.length !== 2 || argv[0] !== '--required-declared') {
    throw new Error('Usage: provider-contract-verifier [--required-declared <provider[,provider...]>]');
  }
  const requiredDeclaredProviders = argv[1]
    .split(',')
    .map((provider) => provider.trim().toLowerCase())
    .filter(Boolean);
  if (requiredDeclaredProviders.length === 0) throw new Error('--required-declared needs at least one provider');
  return { requiredDeclaredProviders };
}

async function main(): Promise<void> {
  const result = await verifyProviderContracts(process.cwd(), parseProviderContractVerifierArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
