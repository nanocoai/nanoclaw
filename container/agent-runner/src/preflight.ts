/** Minimal boot + provider request used by the host config preflight. */
import { loadConfig } from './config.js';
import './providers/index.js';
import { createProvider } from './providers/factory.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const provider = createProvider(config.provider, {
    assistantName: config.assistantName,
    model: config.model,
    effort: config.effort,
    env: { ...process.env },
  });
  const query = provider.query({
    prompt: 'NanoClaw configuration preflight. Reply exactly PREFLIGHT_OK.',
    cwd: '/workspace/agent',
  });
  for await (const event of query.events) {
    if (event.type === 'error') throw new Error(`provider error: ${event.message}`);
    if (event.type === 'result') {
      if (event.isError) throw new Error(`provider rejected candidate: ${event.text || 'unknown provider error'}`);
      console.log(`provider result: ${event.text || '(empty)'}`);
      query.abort();
      query.end();
      return;
    }
  }
  throw new Error('provider ended without a result');
}

main().catch((error) => {
  console.error(`[preflight] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
