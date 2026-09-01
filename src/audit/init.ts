/** PostgreSQL-backed Host audit lifecycle. Importing this module is inert. */
import type { HostStartContext } from '../host-lifecycle.js';
import { onHostShutdown, onHostStart } from '../host-lifecycle.js';
import { log } from '../log.js';
import { AUDIT_ENABLED, AUDIT_RETENTION_HOURS, HOST_AUDIT_PSEUDONYM_KEY_FILE } from './config.js';
import { closeAuditWriteAdmissionAndWait, openAuditWriteAdmission } from './emit.js';
import { initAuditHooks, maintainAuditHooks, shutdownAuditHooks } from './hooks.js';
import { initializeAuditPseudonymizer } from './pseudonym.js';
import {
  initializeAuditStore,
  pruneAuditLogIfDue,
} from './store.js';
import { shutdownAuditStdout } from './stdout.js';

const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

let initialized = false;
let maintenanceInFlight: Promise<void> | null = null;
let maintenanceTimer: NodeJS.Timeout | null = null;
let maintenanceStopping = false;

async function startAuditLog({ db }: HostStartContext): Promise<void> {
  if (!AUDIT_ENABLED || initialized) return;
  // Miscomposition is not an ordinary reporting outage. Refuse startup before
  // any business action if PostgreSQL or the deployed module migration is absent.
  initializeAuditPseudonymizer(HOST_AUDIT_PSEUDONYM_KEY_FILE);
  await initializeAuditStore(db);
  initialized = true;
  maintenanceStopping = false;
  openAuditWriteAdmission();

  initAuditHooks();
  onHostShutdown(async () => {
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    maintenanceTimer = null;
    maintenanceStopping = true;
    await maintenanceInFlight;
    await closeAuditWriteAdmissionAndWait();
    shutdownAuditStdout();
    await shutdownAuditHooks();
  });
  maintenanceTimer = setInterval(() => void maintainAudit(), MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref();
  void maintainAudit();
  log.info('Host audit enabled', { store: 'central-postgresql', retentionHours: AUDIT_RETENTION_HOURS });
}

export async function initAuditLog(context: HostStartContext): Promise<void> {
  await startAuditLog(context);
}

async function runMaintenance(): Promise<void> {
  try {
    await pruneAuditLogIfDue(() => !maintenanceStopping);
  } catch (error) {
    log.error('Audit retention maintenance failed; Host requests remain active', { err: error });
  }
  if (AUDIT_ENABLED) maintainAuditHooks();
}

export function maintainAudit(): Promise<void> {
  if (!maintenanceInFlight) {
    const work = runMaintenance();
    const wrapped = work.finally(() => {
      if (maintenanceInFlight === wrapped) maintenanceInFlight = null;
    });
    maintenanceInFlight = wrapped;
  }
  return maintenanceInFlight;
}

onHostStart(initAuditLog);
