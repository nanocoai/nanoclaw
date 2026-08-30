import { readEnvFile } from '../env.js';
import { DEFAULT_PROJECT_DOCUMENT, registerProviderContainerConfig } from './provider-container-registry.js';

const AGENT_APP = '/app';
const COMPACT_COMMAND = ['bun ', AGENT_APP, '/src/compact-instructions', '.ts'].join('');
const SETTINGS = `${JSON.stringify({
  autoMemoryEnabled: false,
  env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
  hooks: { PreCompact: [{ hooks: [{ type: 'command', command: COMPACT_COMMAND }] }] },
}, null, 2)}\n`;

registerProviderContainerConfig('claude', () => {
  const dotenv = readEnvFile(['ANTHROPIC_BASE_URL']);
  const env: Record<string, string> = { ANTHROPIC_API_KEY: 'nanoco-gateway-managed' };
  if (dotenv.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
    env.ANTHROPIC_AUTH_TOKEN = 'nanoco-gateway-managed';
    delete env.ANTHROPIC_API_KEY;
  }
  return {
    env,
    projectDocument: DEFAULT_PROJECT_DOCUMENT,
    stateVolumes: [{ name: 'claude-state', containerPath: '/home/node/.claude', scope: 'group' }],
    skillViews: [{ containerPath: '/home/node/.claude/skills', mode: 'rw' }],
    seedFiles: [{ containerPath: '/home/node/.claude/settings.json', content: SETTINGS, owner: 'materializer', mode: 0o600 }],
  };
}, { requiresHostFilesystem: false });
