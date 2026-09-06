export interface ClientOptions {
  origin: string;
  token?: string;
  file: string;
  label?: string;
  exclusive?: boolean;
  autoContinue?: boolean;
  waitForLockMs?: number;
  signal?: AbortSignal;
  existingOnly?: boolean;
  log?: (event: { event: string; code?: string; deviceId?: string }) => void;
}
export class DeviceClient {
  constructor(options: ClientOptions);
  origin: string;
  token: string;
  local: Record<string, any>;
  initialize(): Promise<this>;
  request(method: string, route: string, body?: object, signal?: AbortSignal): Promise<any>;
  save(): Promise<void>;
  reconcile(): Promise<any>;
  stop(): Promise<void>;
}

export class SetupClient extends DeviceClient {
  available(stage: string): Promise<boolean>;
  resumeEnabled(stage: string, name?: string): Promise<boolean>;
  start(stage: string, name?: string): Promise<{ url: string }>;
  wait(): Promise<{
    id: string;
    status: string;
    choice: { imageSource: 'hardened' | 'local'; workspaceId: string; name: string };
  }>;
  complete(status?: string, detail?: { appId: string }): Promise<unknown>;
}

export function writePrivate(file: string, value: unknown): Promise<void>;

export function readJson(file: string): Promise<any>;
export function processLock(file: string): Promise<(() => void) | null>;
export function processLockOwner(file: string): { pid: number; nonce: string; started: string } | undefined;
export class CellConnection {
  constructor(options: {
    origin: string;
    getTicket(signal: AbortSignal): Promise<{ ticket: string; socketUrl: string }>;
    onChange?: () => void;
    log?: (event: { event: string; code?: string }) => void;
    heartbeatMs?: number;
    timeoutMs?: number;
    retryMs?: number;
    maxRetryMs?: number;
  });
  connected: boolean;
  start(): void;
  stop(): void;
}
