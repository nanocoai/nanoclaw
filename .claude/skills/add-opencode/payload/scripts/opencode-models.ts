import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as p from '@clack/prompts';
import { readEnvFile } from '../src/env.js';
import { upsertEnvVar } from '../setup/set-env.js';
import {
  chooseOpenCodeModel,
  discoverLocalModelIds,
  discoverRuntimeModels,
  validateModel,
} from './opencode-model-config.js';

export async function runModelSelection(args: string[]): Promise<void> {
  let list = false,
    refresh = false,
    requested: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--list') list = true;
    else if (args[i] === '--refresh') refresh = true;
    else if (args[i] === '--model' && args[i + 1] && !args[i + 1].startsWith('--')) requested = args[++i];
    else throw new Error('Usage: opencode-models.ts [--list] [--refresh] [--model provider/model-id]');
  }
  if (list && requested) throw new Error('--list cannot be combined with --model.');
  const saved = readEnvFile([
    'OPENCODE_PROVIDER',
    'OPENCODE_MODEL',
    'OPENCODE_AUTH_MODE',
    'OPENCODE_BASE_URL',
    'ANTHROPIC_BASE_URL',
  ]);
  const provider = process.env.OPENCODE_PROVIDER ?? saved.OPENCODE_PROVIDER;
  const current = process.env.OPENCODE_MODEL ?? saved.OPENCODE_MODEL;
  const configuredEndpoint = process.env.OPENCODE_BASE_URL ?? saved.OPENCODE_BASE_URL;
  const baseUrl = configuredEndpoint || (process.env.ANTHROPIC_BASE_URL ?? saved.ANTHROPIC_BASE_URL);
  if (!provider) throw new Error('Configure an OpenCode backend first: pnpm exec tsx scripts/opencode-auth.ts');
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(provider)) throw new Error('Invalid configured OpenCode provider id.');
  if (requested && validateModel(requested, provider)) throw new Error(validateModel(requested, provider));
  let models: string[] = [];
  if (!requested || refresh) {
    try {
      if (baseUrl && baseUrl !== 'native') {
        if (provider !== 'openai') throw new Error('Custom endpoint requires a manual model ID.');
        models = (await discoverLocalModelIds(baseUrl)).map((id) => `${provider}/${id}`);
        if (!models.length) throw new Error('The configured endpoint returned no models.');
      } else {
        models = discoverRuntimeModels(
          provider,
          refresh,
          (process.env.OPENCODE_AUTH_MODE ?? saved.OPENCODE_AUTH_MODE) === 'chatgpt',
        );
      }
    } catch {
      if (list)
        throw new Error(
          'Could not read models for the configured backend. Check the endpoint, image and network; settings unchanged.',
        );
      p.log.warn('Could not read models for the configured backend. Keep the current model or enter an id manually.');
    }
  }
  if (list) {
    console.log(models.join('\n'));
    return;
  }
  const selected = requested ?? (await chooseOpenCodeModel(provider, models, current));
  const invalid = validateModel(selected, provider);
  if (invalid) throw new Error(invalid);
  if (process.env.OPENCODE_MODEL !== undefined && process.env.OPENCODE_MODEL !== selected) {
    throw new Error(
      'An exported OPENCODE_MODEL overrides .env. Unset it before changing the saved default; settings unchanged.',
    );
  }
  if (process.env.OPENCODE_PROVIDER !== undefined && process.env.OPENCODE_PROVIDER !== saved.OPENCODE_PROVIDER) {
    throw new Error(
      'An exported OPENCODE_PROVIDER differs from .env. Update the backend configuration first; settings unchanged.',
    );
  }
  if (selected === current) {
    p.log.info(`Keeping ${selected}; settings unchanged.`);
    return;
  }
  upsertEnvVar('OPENCODE_MODEL', selected);
  p.log.success(
    `Default model set to ${selected}. Authentication, backend, small model, and group overrides are unchanged.`,
  );
  p.log.info(
    'Restart the NanoClaw host and affected groups to use the new default. Per-group model overrides still win.',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runModelSelection(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Model selection failed');
    process.exitCode = 1;
  });
}
