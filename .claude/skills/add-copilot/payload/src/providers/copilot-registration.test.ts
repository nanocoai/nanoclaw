import { describe, expect, it, vi } from 'vitest';

vi.mock('../env.js', () => ({ readEnvFile: () => ({}) }));

import './index.js';
import '../provider-contracts/index.js';
import { providerStateVolumePath } from '../provider-contracts/realize.js';
import { getProviderHostContract } from '../provider-contracts/registry.js';
import { getProviderContainerConfig } from './provider-container-registry.js';

describe('Copilot host registration', () => {
  it('keeps the standard project document and skills without mounting host Copilot credentials', () => {
    const contract = getProviderHostContract('copilot');
    expect(contract?.projectDocument.containerPath).toBe('/workspace/agent/CLAUDE.md');
    expect(contract?.skillBackings).toHaveLength(1);
    expect(contract?.stateVolumes).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ containerPath: '/home/node/.copilot' })]),
    );
    expect(contract?.stateVolumes).toEqual(
      expect.arrayContaining([expect.objectContaining({ directory: '.copilot-shared', scope: 'group' })]),
    );
    expect(contract?.stateVolumes).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ directory: '.claude-shared' })]),
    );
    expect(contract?.skillBackings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ location: { kind: 'state-volume', volumeId: 'claude-home', subdirectory: '' } }),
      ]),
    );
    expect(contract?.modelDomains).toContain('api.business.githubcopilot.com');
    expect(contract?.modelDomains).toContain('api.individual.githubcopilot.com');
    expect(contract?.modelDomains).not.toContain('api.github.com');
    const copilotVolume = contract?.stateVolumes[0];
    const claudeVolume = getProviderHostContract('claude')?.stateVolumes[0];
    expect(copilotVolume).toBeDefined();
    expect(claudeVolume).toBeDefined();
    if (!copilotVolume || !claudeVolume) {
      throw new Error('Provider state volume is missing');
    }
    expect(providerStateVolumePath(copilotVolume, 'test-group')).not.toBe(
      providerStateVolumePath(claudeVolume, 'test-group'),
    );
  });

  it('passes only the selected model and endpoint, not host credentials', async () => {
    const contribution = await getProviderContainerConfig('copilot')?.({
      hostEnv: {
        COPILOT_MODEL: 'auto',
        COPILOT_API_URL: 'https://api.business.githubcopilot.com',
        GITHUB_TOKEN: 'do-not-forward',
        ANTHROPIC_API_KEY: 'do-not-forward',
      },
      groupDir: '/tmp/group',
      sessionDir: '/tmp/session',
      agentGroupId: 'test',
      selectedSkills: [],
    });
    expect(contribution?.env).toEqual({
      COPILOT_MODEL: 'auto',
      COPILOT_API_URL: 'https://api.business.githubcopilot.com',
    });
  });
});
