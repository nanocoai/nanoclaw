/**
 * Fallback module barrel — registers the `fallback_report` / `provider_error`
 * delivery actions and wires the global provider override to live DB state.
 * Import for side effects only (see src/modules/index.ts).
 */
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';
import { registerGlobalProviderOverride } from '../../provider-override.js';
import { getFallbackState } from './db.js';
import { handleFallbackReport, handleProviderError } from './controller.js';
import { effectiveProvider } from './override.js';
import './cli.js';

registerDeliveryAction(
  'fallback_report',
  handleFallbackReport,
  unguarded('provider self-report of a usage-limit signal — no user/agent input, nothing to authorize'),
);
registerDeliveryAction(
  'provider_error',
  handleProviderError,
  unguarded('provider self-report of a non-limit error — no user/agent input, nothing to authorize'),
);

registerGlobalProviderOverride((native) => {
  try {
    return effectiveProvider(native, getFallbackState());
  } catch (err) {
    log.warn('Failed to read fallback state for provider override — falling back to native', { err });
    return native;
  }
});
