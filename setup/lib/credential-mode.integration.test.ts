import { afterEach, describe, expect, it, vi } from 'vitest';
import * as brightSelectModule from './bright-select.js';
import * as oauthDetect from './claude-oauth-detect.js';
import { runCredentialModeStep } from './credential-mode.js';

describe('runCredentialModeStep', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns native + skipOneCli=true when pickCredentialMode returns native', async () => {
    vi.spyOn(brightSelectModule, 'brightSelect').mockResolvedValue('native');
    vi.spyOn(oauthDetect, 'detectClaudeOAuthToken').mockReturnValue('keychain');
    const result = await runCredentialModeStep({} as NodeJS.ProcessEnv);
    expect(result).toEqual({ mode: 'native', skipOneCli: true });
  });

  it('returns onecli + skipOneCli=false when pickCredentialMode returns onecli', async () => {
    vi.spyOn(brightSelectModule, 'brightSelect').mockResolvedValue('onecli');
    vi.spyOn(oauthDetect, 'detectClaudeOAuthToken').mockReturnValue(null);
    const result = await runCredentialModeStep({} as NodeJS.ProcessEnv);
    expect(result).toEqual({ mode: 'onecli', skipOneCli: false });
  });

  it('passes detected oauthSource to pickCredentialMode as a hint', async () => {
    vi.spyOn(oauthDetect, 'detectClaudeOAuthToken').mockReturnValue('file');
    const brightSelectSpy = vi
      .spyOn(brightSelectModule, 'brightSelect')
      .mockResolvedValue('native');
    await runCredentialModeStep({ HOME: '/home/test' } as NodeJS.ProcessEnv);
    // Verify the hint passed to brightSelect reflects the detected 'file' source
    const callArgs = brightSelectSpy.mock.calls[0][0] as { options: { value: string; hint?: string }[] };
    const nativeOption = callArgs.options.find((o) => o.value === 'native');
    expect(nativeOption?.hint).toMatch(/credentials\.json/);
  });
});
