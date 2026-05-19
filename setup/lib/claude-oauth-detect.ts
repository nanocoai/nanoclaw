/**
 * Detect whether a Claude Code OAuth token is available on this host.
 *
 * Two sources, file wins when both present:
 *   - file:     ~/.claude/.credentials.json (Linux + macOS)
 *   - keychain: macOS Keychain entry "Claude Code-credentials"
 *               (only probed on platform === 'darwin')
 *
 * Returns the SOURCE — not the token. The credential proxy reads the
 * token at runtime; setup only needs to know whether to surface a
 * "✓ detected" hint in the credential-mode prompt.
 *
 * Reference: chiptoe-svg/nanoclaw_gccourse main, setup/auto.ts
 * extractClaudeCodeOAuthToken / runNativeAuthStep.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export type OAuthSource = 'file' | 'keychain';

export interface DetectInput {
  HOME?: string;
  platform: NodeJS.Platform;
}

export interface DetectDeps {
  fileExists: (p: string) => boolean;
  readFile: (p: string) => string;
  execKeychainQuery: () => string;
}

export function detectClaudeOAuthToken(input: DetectInput, deps?: Partial<DetectDeps>): OAuthSource | null {
  const d = createDeps(deps);
  if (fileHasOAuthToken(input.HOME, d)) return 'file';
  if (input.platform === 'darwin' && keychainHasOAuthToken(d)) return 'keychain';
  return null;
}

function createDeps(overrides?: Partial<DetectDeps>): DetectDeps {
  return {
    fileExists: (p) => fs.existsSync(p),
    readFile: (p) => fs.readFileSync(p, 'utf-8'),
    execKeychainQuery: () =>
      execSync('security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    ...overrides,
  };
}

function fileHasOAuthToken(home: string | undefined, deps: DetectDeps): boolean {
  if (!home) return false;
  const credPath = path.join(home, '.claude', '.credentials.json');
  if (!deps.fileExists(credPath)) return false;
  try {
    const raw = deps.readFile(credPath);
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
    return typeof parsed.claudeAiOauth?.accessToken === 'string';
  } catch {
    return false;
  }
}

function keychainHasOAuthToken(deps: DetectDeps): boolean {
  try {
    const raw = deps.execKeychainQuery();
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
    return typeof parsed.claudeAiOauth?.accessToken === 'string';
  } catch {
    return false;
  }
}
