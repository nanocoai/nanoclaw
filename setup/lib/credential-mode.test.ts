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
});
