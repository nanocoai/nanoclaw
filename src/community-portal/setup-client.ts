import { setTimeout as sleep } from 'node:timers/promises';
import { DeviceClient, type DeviceClientOptions, type SetupFlow } from './device-client.js';
import { errorCode, errorStatus } from './errors.js';

/**
 * The setup wizard's side of a browser handoff: start a stage for the
 * registered device (or anonymously, carrying the registry device flow's user
 * code so one browser visit covers sign-in, terminal approval and the perk),
 * print its link, claim the flow once signed in, poll until the browser
 * finishes, and report the outcome. There is nothing to unseal and nothing to
 * save into account.json here; the sign-in owns that file.
 */
export interface CatalogItem {
  id: string;
  kind: string;
  enabled?: boolean;
}

export interface SetupChoice {
  imageSource?: 'hardened' | 'local';
  workspaceId: string;
  name: string;
}

/** The public setup state (`GET /api/v1/setup/{code}`). */
export interface SetupState {
  id: string;
  stage?: string;
  deviceId?: string;
  label?: string;
  name?: string;
  status: string;
  choice: SetupChoice;
  appId?: string;
  error?: string;
  createdAt?: string;
  expiresAt?: string;
  [key: string]: unknown;
}

/** The registry device flow's public display data for an anonymous start; never a secret. */
export interface SetupVerification {
  userCode: string;
  verificationUri: string;
}

export interface StartOptions {
  reuseEnabled?: boolean;
  /** Start without a bearer: the flow waits in `awaiting_installation` until `claim()`. */
  verification?: SetupVerification;
}

export interface SetupClientOptions extends DeviceClientOptions {
  /** Ask the portal to return to the terminal as soon as the perk is enabled. */
  autoContinue?: boolean;
}

const LIVE_FLOW_STATES = ['pending', 'authorizing', 'browsing', 'approved', 'awaiting_approval'];
const FINISHED_STATES = ['approved', 'awaiting_approval', 'skipped'];

export class SetupClient extends DeviceClient {
  flow?: SetupFlow;
  private readonly autoContinue: boolean;

  constructor({ autoContinue = false, ...options }: SetupClientOptions) {
    super(options);
    this.autoContinue = autoContinue;
  }

  /** Whether the release catalog offers `stage` right now. */
  async available(stage: string): Promise<boolean> {
    const { items } = await this.request<{ items: CatalogItem[] }>('GET', '/api/v1/catalog');
    return items.some((item) => item.id === stage && (item.kind === 'account' || item.enabled === true));
  }

  /** True when the signed-in installation already has `stage` enabled; never opens a browser. */
  async resumeEnabled(stage: string, name = 'Nano'): Promise<boolean> {
    if (!this.identity) return false;
    try {
      await this.start(stage, name, { reuseEnabled: true });
      return true;
    } catch (error) {
      if (errorStatus(error) === 401) return false;
      if (['perk_not_enabled', 'installation_required'].includes(errorCode(error, ''))) return false;
      throw error;
    }
  }

  /**
   * Start (or resume an unexpired) browser flow for `stage`. With a bearer the
   * flow binds to the registered device; with `verification` it is anonymous
   * and binds to nothing until claimed.
   */
  async start(
    stage: string,
    name = 'Nano',
    { reuseEnabled = false, verification }: StartOptions = {},
  ): Promise<SetupFlow> {
    if (verification) {
      this.flow = await this.request<SetupFlow>('POST', '/api/v1/setup/start', {
        stage,
        name,
        autoContinue: this.autoContinue,
        label: this.label,
        verification,
      });
      this.flow.stage = stage;
      this.local.setupFlow = this.flow;
      await this.save();
      return this.flow;
    }
    const previous = this.local.setupFlow;
    if (!reuseEnabled && previous?.stage === stage && Date.parse(previous.expiresAt) > Date.now()) {
      this.flow = previous;
      try {
        if (LIVE_FLOW_STATES.includes((await this.status()).status)) return previous;
      } catch (error) {
        const status = errorStatus(error);
        if (status !== 410 && status !== 401 && status !== 404) throw error;
      }
    }
    this.flow = await this.request<SetupFlow>('POST', '/api/v1/setup/start', {
      stage,
      name,
      reuseEnabled,
      autoContinue: this.autoContinue,
      label: this.label,
    });
    this.flow.stage = stage;
    this.local.setupFlow = this.flow;
    await this.save();
    return this.flow;
  }

  status(): Promise<SetupState> {
    return this.request<SetupState>('GET', `/api/v1/setup/${this.currentFlow().code}`);
  }

  /** Bind an anonymously started flow to this (now signed-in, registered) installation. */
  claim(): Promise<SetupState> {
    return this.request<SetupState>('POST', `/api/v1/setup/${this.currentFlow().code}/claim`, {});
  }

  /** Poll the flow until the browser finishes it; resolves to the public setup state. */
  async wait({ pollMs = 1500, onState = (_state: SetupState): void => {} } = {}): Promise<SetupState> {
    const flow = this.currentFlow();
    while (Date.now() < Date.parse(flow.expiresAt)) {
      let result: SetupState;
      try {
        result = await this.status();
      } catch (error) {
        const status = errorStatus(error);
        if (status && status < 500 && status !== 429) throw error;
        await sleep(pollMs);
        continue;
      }
      onState(result);
      if (FINISHED_STATES.includes(result.status)) {
        if (result.deviceId && result.deviceId !== this.local.deviceId) {
          this.local.deviceId = result.deviceId;
          await this.save();
        }
        return result;
      }
      if (['cancelled', 'failed'].includes(result.status))
        throw new Error('Setup was cancelled or failed. Restart this step.');
      await sleep(pollMs);
    }
    throw new Error('Browser setup timed out. Restart this step to get a new link.');
  }

  complete(status = 'complete', detail: Record<string, unknown> = {}): Promise<unknown> {
    return this.request('POST', `/api/v1/setup/${this.currentFlow().code}/complete`, { status, ...detail });
  }

  private currentFlow(): SetupFlow {
    if (!this.flow) throw new Error('Start a setup stage before polling it.');
    return this.flow;
  }
}
