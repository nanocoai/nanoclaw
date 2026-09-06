/**
 * Self-registration for the Apple Container driver (kind 'container').
 * Reached via the `installed.ts` barrel; select with
 * `NANOCLAW_RUNTIME_DRIVER=container` in `.env`.
 */
import { AppleContainerSessionDriver } from './apple-container-driver.js';
import { registerSessionDriver } from './driver-registry.js';

registerSessionDriver('container', (policy) => new AppleContainerSessionDriver(policy));
