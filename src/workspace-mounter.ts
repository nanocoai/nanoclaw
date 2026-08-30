export interface WorkspaceContainerSpec {
  role: 'agent' | 'egress-sidecar' | 'workspace-mounter' | 'workspace-ready';
  image: string;
  env: Record<string, string>;
  command: string[];
  args: string[];
  mounts: Array<{
    class: 'group-state' | 'identity-material';
    hostPath: string;
    containerPath: string;
    mode: 'ro' | 'rw';
    groupScope: string;
  }>;
  labels: Record<string, string>;
}

export const WORKSPACE_MOUNT_PATH = '/workspace/group';
export const WORKSPACE_CIPHER_PATH = '/cipher';
export const WORKSPACE_PASSFILE_PATH = '/run/nanoco/gocryptfs.pass';
export const ENCRYPTED_WORKSPACE_DORMANT_ON_CONTAINER_TIER =
  'the legacy per-session workspace mounter is removed; use the dedicated workspace Controller and Custodian';

export interface WorkspaceMounterOptions {
  groupId: string;
  replicaRoot: string;
  image: string;
}

export function workspaceMounterContainers(_options: WorkspaceMounterOptions): WorkspaceContainerSpec[] {
  throw new Error('per-session workspace mounters are disabled; the Controller/Custodian workspace plane is required');
}
