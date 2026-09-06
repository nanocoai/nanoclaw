export class SetupClient {
  constructor(options: { origin: string; token?: string; file: string; label: string; exclusive?: boolean });
  token: string;
  local: Record<string, any>;
  initialize(): Promise<this>;
  resumeEnabled(stage: string, name?: string): Promise<boolean>;
  start(stage: string, name?: string): Promise<{ url: string }>;
  wait(): Promise<{ id: string; status: string; choice: { imageSource: 'hardened' | 'local'; workspaceId: string; name: string } }>;
  save(): Promise<void>;
  complete(status?: string, detail?: { appId: string }): Promise<unknown>;
  reconcile(): Promise<void>;
  stop(): Promise<void>;
}

export function writePrivate(file: string, value: unknown): Promise<void>;
