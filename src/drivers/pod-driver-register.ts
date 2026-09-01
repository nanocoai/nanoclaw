/**
 * Installs the Pod driver into the host's session-driver registry.
 *
 * This file is the whole wiring. It is reached by one appended import line in
 * `src/drivers/installed.ts` — the barrel trunk keeps for exactly this — so the
 * skill adds a driver without editing any expression trunk owns. Selection
 * stays the seam's (`NANOCLAW_RUNTIME_DRIVER=pod`, read from `.env` with
 * `process.env` precedence); nothing above the selection module branches on the
 * driver's identity, because features gate on `capabilities()`.
 *
 * Registering from the registry module rather than from `index.ts` is load
 * bearing: the appended import is evaluated before the importing module's body,
 * so reaching for selection's own exports here would touch the registry map in
 * its temporal dead zone.
 */
import { registerSessionDriver } from './driver-registry.js';
import { PodSessionDriver } from './pod-driver.js';
import { kataAvailable } from './runtime-class.js';

// The factory takes the resolved mount policy and nothing else. Pod-only
// settings (the namespace, the kata wiring) are read by the driver's own
// code, so trunk's settings list never grows a key that means nothing without
// this file. Kata availability resolves at factory time — when selection
// creates the driver, not when this import is evaluated — so the declaration
// is read from the same booted environment as every other setting.
registerSessionDriver('pod', (policy) => new PodSessionDriver({ ...policy, kataAvailable: kataAvailable() }));
