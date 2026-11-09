import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installCommand, InstallCommandFailure } from './install-command.js';

const skill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(fs.readFileSync(path.join(skill, 'versions.json'), 'utf8'));
const compatibility = path.resolve(skill, '../../../gateway-compat/onecli-summary');
const summaryPin = JSON.parse(fs.readFileSync(path.join(compatibility, 'upstream.json'), 'utf8'));
const onecliPin = JSON.parse(fs.readFileSync(path.join(skill, '../add-onecli/versions.json'), 'utf8'));
if (summaryPin.version !== onecliPin['onecli-gateway'])
  throw new Error('Approval compatibility must match the pinned OneCLI gateway');
const compatibilityInputs = ['Cargo.toml', 'Cargo.lock', 'src/main.rs', 'prepare.py', 'upstream.json'];
export const frontProxyHash = createHash('sha256')
  .update(
    compatibilityInputs
      .map((file) => fs.readFileSync(path.join(compatibility, file)))
      .reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0)),
  )
  .update(fs.readFileSync(path.join(skill, 'assets/managed-proxy.Dockerfile')))
  .update(
    Buffer.concat(
      fs
        .readdirSync(path.join(skill, 'front-proxy'))
        .sort()
        .map((file) => Buffer.concat([Buffer.from(file), fs.readFileSync(path.join(skill, 'front-proxy', file))])),
    ),
  )
  .update(fs.readFileSync(path.join(skill, 'assets/entrypoint.sh')))
  .digest('hex');

export function hasFrontProxy(image: { Config: { Labels?: Record<string, string> } }): boolean {
  return (
    image.Config.Labels?.['org.opencontainers.image.revision'] === pins['iron-proxy-commit'] &&
    image.Config.Labels?.['ai.nanoclaw.approval-front'] === frontProxyHash
  );
}

/** Build unmodified upstream Iron and the separate NanoClaw approval front. */
export async function buildManagedProxy(): Promise<string> {
  const tag = `nanoclaw-iron-proxy-managed:${frontProxyHash.slice(0, 12)}`;
  try {
    const image = JSON.parse(
      await installCommand('docker', ['image', 'inspect', tag], {
        label: 'Check cached Iron Proxy image',
        timeoutMs: 15_000,
        capture: true,
        absentHint: 'not cached; building it from the pinned source',
      }),
    )[0];
    if (hasFrontProxy(image)) return image.Id;
  } catch (error) {
    if (error instanceof InstallCommandFailure && error.interrupted) throw error;
    // A missing cached image is built below.
  }
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-managed-proxy-'));
  try {
    const git = (args: string[], label = 'Prepare Iron Proxy source') =>
      installCommand('git', args, {
        cwd: source,
        label,
        timeoutMs: 120_000,
        failureHint:
          'The pinned source could not be fetched or prepared. Verify repository access from this machine and retry; setup will not prompt for credentials.',
      });
    await git(['init', '-q']);
    await git(['remote', 'add', 'origin', pins['iron-proxy-source']]);
    await git(['fetch', '--depth', '1', 'origin', pins['iron-proxy-commit']], 'Fetch pinned Iron Proxy source');
    await git(['checkout', '--detach', 'FETCH_HEAD']);
    await git(['diff', '--exit-code']);
    fs.cpSync(path.join(skill, 'front-proxy'), path.join(source, '_front-proxy'), { recursive: true });
    fs.copyFileSync(path.join(skill, 'assets/entrypoint.sh'), path.join(source, '_entrypoint.sh'));
    const summarySource = path.join(source, '_approval-summary');
    fs.mkdirSync(path.join(summarySource, 'src'), { recursive: true });
    for (const file of [...compatibilityInputs, 'LICENSE.onecli']) {
      fs.copyFileSync(path.join(compatibility, file), path.join(summarySource, file));
    }
    await installCommand('python3', [path.join(summarySource, 'prepare.py')], {
      label: 'Download pinned approval compatibility sources',
      timeoutMs: 120_000,
      failureHint: 'Check access to the pinned public OneCLI source and retry.',
    });
    await installCommand(
      'docker',
      [
        'build',
        '-f',
        path.join(skill, 'assets/managed-proxy.Dockerfile'),
        '-t',
        tag,
        '--label',
        `org.opencontainers.image.revision=${pins['iron-proxy-commit']}`,
        '--label',
        `ai.nanoclaw.approval-front=${frontProxyHash}`,
        source,
      ],
      {
        label: 'Build and test Iron Proxy image',
        timeoutMs: 1_200_000,
        failureHint: 'Check Docker, base-image registry access and build resources, then retry.',
      },
    );
    return await installCommand('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'], {
      label: 'Record built Iron Proxy image',
      timeoutMs: 15_000,
      capture: true,
    });
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
  }
}
