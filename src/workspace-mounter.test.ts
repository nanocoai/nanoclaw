import { describe, expect, it } from 'vitest';

import { workspaceMounterContainers } from './workspace-mounter.js';

describe('Custodian-only workspace contract', () => {
  it('cannot compose a privileged per-session workspace mounter', () => {
    expect(() => workspaceMounterContainers({
      groupId: 'agent-group',
      replicaRoot: '/var/lib/nanoco/workspaces',
      image: 'agent:local',
    })).toThrow('Controller/Custodian');
  });
});
