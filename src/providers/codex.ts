import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

function readHostCodexAuthJson(hostEnv: NodeJS.ProcessEnv): string | undefined {
  const dotenv = readEnvFile(['CODEX_AUTH_JSON']);
  if (dotenv.CODEX_AUTH_JSON) return dotenv.CODEX_AUTH_JSON;
  if (hostEnv.CODEX_AUTH_JSON) return hostEnv.CODEX_AUTH_JSON;

  const authPath = path.join(os.homedir(), '.codex', 'auth.json');
  return fs.existsSync(authPath) ? fs.readFileSync(authPath, 'utf8') : undefined;
}

registerProviderContainerConfig('codex', (ctx) => {
  const codexDir = path.join(ctx.sessionDir, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });

  const authJson = readHostCodexAuthJson(ctx.hostEnv);
  if (authJson) {
    JSON.parse(authJson);
    fs.writeFileSync(path.join(codexDir, 'auth.json'), authJson);
  }

  const dotenv = readEnvFile(['OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN']);
  const env: Record<string, string> = {
    CODEX_HOME: '/home/node/.codex',
  };
  const openAiApiKey = dotenv.OPENAI_API_KEY ?? ctx.hostEnv.OPENAI_API_KEY;
  if (openAiApiKey) env.OPENAI_API_KEY = openAiApiKey;
  const codexAccessToken = dotenv.CODEX_ACCESS_TOKEN ?? ctx.hostEnv.CODEX_ACCESS_TOKEN;
  if (codexAccessToken) env.CODEX_ACCESS_TOKEN = codexAccessToken;

  return {
    mounts: [{ hostPath: codexDir, containerPath: '/home/node/.codex', readonly: false }],
    env,
  };
});
