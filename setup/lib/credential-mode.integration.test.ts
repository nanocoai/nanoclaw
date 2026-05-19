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

  it('pre-set NANOCLAW_CREDENTIAL_MODE=native is respected when step would be skipped', async () => {
    // Scenario: credential-mode step was run previously and wrote NANOCLAW_CREDENTIAL_MODE=native to .env.
    // On a subsequent setup run with NANOCLAW_SKIP=credential-mode, the step is not called at all
    // in auto.ts, but this test documents that pickCredentialMode returns the pre-set value immediately
    // without prompting (this is what happens if the step were to be called with a pre-set env).
    vi.spyOn(oauthDetect, 'detectClaudeOAuthToken').mockReturnValue(null);
    const brightSelectSpy = vi.spyOn(brightSelectModule, 'brightSelect');
    const env = { NANOCLAW_CREDENTIAL_MODE: 'native' } as NodeJS.ProcessEnv;
    const result = await runCredentialModeStep(env);
    // brightSelect should NOT be called — pickCredentialMode returns early because the mode is valid
    expect(brightSelectSpy).not.toHaveBeenCalled();
    // The result reflects the pre-set mode and correctly maps to skipOneCli=true
    expect(result).toEqual({ mode: 'native', skipOneCli: true });
  });
});
