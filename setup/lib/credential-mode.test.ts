import { describe, expect, it, vi } from 'vitest';
import * as brightSelectModule from './bright-select.js';
import { pickCredentialMode, type CredentialMode } from './credential-mode.js';

describe('pickCredentialMode', () => {
  it('returns the env var when set to "native" without prompting', async () => {
    const promptSpy = vi.spyOn(brightSelectModule, 'brightSelect');
    const result = await pickCredentialMode({ NANOCLAW_CREDENTIAL_MODE: 'native' } as NodeJS.ProcessEnv);
    expect(result).toBe('native');
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it('returns the env var when set to "onecli" without prompting', async () => {
    const promptSpy = vi.spyOn(brightSelectModule, 'brightSelect');
    const result = await pickCredentialMode({ NANOCLAW_CREDENTIAL_MODE: 'onecli' } as NodeJS.ProcessEnv);
    expect(result).toBe('onecli');
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it('prompts when env var is unset', async () => {
    const promptSpy = vi
      .spyOn(brightSelectModule, 'brightSelect')
      .mockResolvedValue('native' satisfies CredentialMode);
    const result = await pickCredentialMode({} as NodeJS.ProcessEnv);
    expect(promptSpy).toHaveBeenCalledTimes(1);
    expect(result).toBe('native');
    promptSpy.mockRestore();
  });

  it('treats invalid env values as unset and re-prompts', async () => {
    const promptSpy = vi
      .spyOn(brightSelectModule, 'brightSelect')
      .mockResolvedValue('onecli' satisfies CredentialMode);
    const result = await pickCredentialMode({ NANOCLAW_CREDENTIAL_MODE: 'garbage' } as NodeJS.ProcessEnv);
    expect(promptSpy).toHaveBeenCalledTimes(1);
    expect(result).toBe('onecli');
    promptSpy.mockRestore();
  });

  it('hint reflects keychain detection when oauthSource is "keychain"', async () => {
    const spy = vi
      .spyOn(brightSelectModule, 'brightSelect')
      .mockResolvedValue('native' satisfies CredentialMode);
    await pickCredentialMode({} as NodeJS.ProcessEnv, { oauthSource: 'keychain' });
    const callArgs = spy.mock.calls[0][0] as { options: { value: string; hint?: string }[] };
    const nativeOption = callArgs.options.find((o) => o.value === 'native');
    expect(nativeOption?.hint).toMatch(/Keychain/);
    spy.mockRestore();
  });

  it('hint reflects file detection when oauthSource is "file"', async () => {
    const spy = vi
      .spyOn(brightSelectModule, 'brightSelect')
      .mockResolvedValue('native' satisfies CredentialMode);
    await pickCredentialMode({} as NodeJS.ProcessEnv, { oauthSource: 'file' });
    const callArgs = spy.mock.calls[0][0] as { options: { value: string; hint?: string }[] };
    const nativeOption = callArgs.options.find((o) => o.value === 'native');
    expect(nativeOption?.hint).toMatch(/credentials\.json/);
    spy.mockRestore();
  });

  it('hint falls back to generic text when oauthSource is undefined', async () => {
    const spy = vi
      .spyOn(brightSelectModule, 'brightSelect')
      .mockResolvedValue('native' satisfies CredentialMode);
    await pickCredentialMode({} as NodeJS.ProcessEnv, { oauthSource: undefined });
    const callArgs = spy.mock.calls[0][0] as { options: { value: string; hint?: string }[] };
    const nativeOption = callArgs.options.find((o) => o.value === 'native');
    expect(nativeOption?.hint).toMatch(/no extra daemon/);
    spy.mockRestore();
  });
});
