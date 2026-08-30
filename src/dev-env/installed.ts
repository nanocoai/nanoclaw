/**
 * The barrel overlays append their dev-env driver registrations to — one
 * side-effect import per driver, same shape as `../drivers/installed.ts`.
 * The mock ships only via its explicit test wiring, on purpose.
 */
import './docker-driver-register.js';
import './k8s-driver-register.js';

export {};
