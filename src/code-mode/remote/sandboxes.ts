/**
 * Sandbox addresses. On a host with remote access enabled every named
 * sandbox gets an address of its own from the account service, so a
 * terminal can land in it directly instead of through the account's default
 * sandbox. Registration is best effort by contract: it never fails or delays
 * the sandbox verb; a checkout that is not set up with the service, or a
 * service that is down, leaves a plain sandbox; and the default sandbox
 * named after the account is never registered. Deleting a sandbox frees its
 * address the same way.
 */
import * as doorModule from '../door/index.js';
import { checkoutClient, errorCode, type LinkLog } from '../../community-portal/index.js';
import { log as hostLogger } from '../../log.js';

const hostLog: LinkLog = (event) => hostLogger.info('Remote terminal', event);

export interface SandboxAddressOptions {
  root?: string;
  homeDir?: string;
  log?: LinkLog;
  /** Test seam: the door's status. */
  doorStatus?: typeof doorModule.doorStatus;
}

export interface SandboxAddressOutcome {
  /** The service recorded the change. */
  done: boolean;
  address?: string;
  host?: string;
  /** Why not: `not_enabled`, `default_sandbox`, `installation_required`, or the code the service or network gave. */
  code?: string;
}

/** Register a sandbox's name with the account; it gets an address of its own. */
export async function registerSandbox(
  name: string,
  { root = process.cwd(), homeDir, log = hostLog, doorStatus = doorModule.doorStatus }: SandboxAddressOptions = {},
): Promise<SandboxAddressOutcome> {
  try {
    const status = await doorStatus();
    if (!status.enabled) return { done: false, code: 'not_enabled' };
    if (status.name === name) return { done: false, code: 'default_sandbox' };
    const client = await checkoutClient({ root, homeDir, log });
    if (!client) return { done: false, code: 'installation_required' };
    const result = await client.terminalSandboxAdd(name);
    log({ event: 'sandbox_registered', sandbox: name, ...(result.host ? { host: result.host } : {}) });
    return { done: true, address: result.address, ...(result.host ? { host: result.host } : {}) };
  } catch (error) {
    const code = errorCode(error);
    log({ event: 'sandbox_register_failed', sandbox: name, code });
    return { done: false, code };
  }
}

/** Free a sandbox's address once the sandbox is gone; attempted whenever the account ever named this machine. */
export async function unregisterSandbox(
  name: string,
  { root = process.cwd(), homeDir, log = hostLog, doorStatus = doorModule.doorStatus }: SandboxAddressOptions = {},
): Promise<SandboxAddressOutcome> {
  try {
    const status = await doorStatus();
    if (!status.name) return { done: false, code: 'not_enabled' };
    if (status.name === name) return { done: false, code: 'default_sandbox' };
    const client = await checkoutClient({ root, homeDir, log });
    if (!client) return { done: false, code: 'installation_required' };
    await client.terminalSandboxRemove(name);
    log({ event: 'sandbox_unregistered', sandbox: name });
    return { done: true };
  } catch (error) {
    const code = errorCode(error);
    log({ event: 'sandbox_unregister_failed', sandbox: name, code });
    return { done: false, code };
  }
}
