export interface PortalRuntimeOptions {
  root?: string;
  signal?: AbortSignal;
  log?: (event: { event: string; code?: string; deviceId?: string }) => void;
  intervalMs?: number;
}
export function startPortalRuntime(options?: PortalRuntimeOptions): { stop(): Promise<void> };
