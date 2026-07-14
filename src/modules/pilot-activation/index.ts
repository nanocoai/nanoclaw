/**
 * Pilot activation module — shellano pilot onboarding via Telegram.
 *
 * Registers POST /api/register on the shared HTTP server. The Telegram
 * adapter imports tryActivatePilot directly for the START interceptor.
 */
import { registerHttpRoute } from '../../webhook-server.js';
import { handleRegister } from './register-endpoint.js';

export { tryActivatePilot } from './activation.js';

registerHttpRoute('POST', '/api/register', handleRegister);
