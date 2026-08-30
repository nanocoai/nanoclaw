/**
 * NanoClaw — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 */
import { backfillContainerConfigs } from './backfill-container-configs.js';
import { CENTRAL_DB_PATH } from './config.js';
import { enforceStartupBackoff, resetCircuitBreaker } from './circuit-breaker.js';
import { adoptRunningSessions, detachGatewaySessions } from './container-runner.js';
import { closeDb, initDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { getSessionDriver } from './drivers/index.js';
import { getGatewayProvider } from './gateway-providers/index.js';
import { startActiveDeliveryPoll, startSweepDeliveryPoll, setDeliveryAdapter, stopDeliveryPolls } from './delivery.js';
import { startHostInstanceLease, stopHostInstanceLease } from './host-instance.js';
import { startActiveHostGate, stopActiveHostGate } from './modules/single-active-host/index.js';
import { controllerPlane, gatewayPlane, HOST_ROLE, isSplitController, isSplitGateway, markGatewayReady } from './modules/process-split/role.js';
import { startNclControlServer, stopNclControlServer } from './modules/ncl-control-mtls/control-server.js';
import { awaitSchemaCurrent, startWakeSignalConsumer, stopWakeSignalConsumer } from './modules/process-split/cross-plane.js';
import { startCliDispatchConsumer, stopCliDispatchConsumer } from './modules/process-split/cli-delegation.js';
import { startDmResolutionConsumer, stopDmResolutionConsumer } from './modules/process-split/dm-delegation.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { startHostModules, stopHostModules } from './host-lifecycle.js';
import { routeInbound } from './router.js';
import { log } from './log.js';
import { enforceUpgradeTripwire } from './upgrade-state.js';

// Response registry lives in response-registry.ts to break the
// circular import cycle: src/index.ts imports src/modules/index.js for side
// effects, and the modules call registerResponseHandler at top level — which
// would hit a TDZ error if the array lived here.
import { dispatchResponse, logResponseDispatchError } from './response-registry.js';

const hostAbortController = new AbortController();


// Channel barrel — each enabled channel self-registers on import.
// Channel skills uncomment lines in channels/index.ts to enable them.
import './channels/index.js';

// Modules barrel — imports registration modules, including the singular
// mailbox composition slot. Imported for side effects.
import './modules/index.js';

// Code mode — registers the group-flag migration; behavior changes only for
// groups whose config sets code_mode.
import './code-mode/index.js';

// Dev-env seam — registers its migration and lifecycle hooks; dormant until a
// driver is configured (NANOCLAW_DEV_ENV_DRIVER).
import './dev-env/index.js';

// CLI command barrel — populates the `ncl` registry before the CLI server
// accepts connections.
import './cli/commands/index.js';
import './cli/delivery-action.js';
import { startCliServer, stopCliServer } from './cli/socket-server.js';

import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import {
  initChannelAdapters,
  teardownChannelAdapters,
  createChannelDeliveryAdapter,
} from './channels/channel-registry.js';

async function main(): Promise<void> {
  log.info('NanoClaw starting');

  // 0. Circuit breaker — backoff on rapid restarts
  await enforceStartupBackoff();

  // 0.5 Upgrade tripwire — refuse to start if this install was updated
  // outside the sanctioned path (raw `git pull` instead of /update-nanoclaw).
  enforceUpgradeTripwire();

  // 1. Init central DB
  const db = await initDb(
    { path: CENTRAL_DB_PATH, hostLock: HOST_ROLE === 'all' } as { path: string; hostLock: boolean },
    { role: 'host' },
  );
  // Migrations have one owner: the controller plane (and the un-split host).
  // A split gateway waits for the schema instead of racing DDL with its
  // sibling.
  if (isSplitGateway()) await awaitSchemaCurrent(() => runMigrations(db, undefined, { mode: 'validate' }));
  else await runMigrations(db, undefined, { mode: 'auto' });
  log.info('Central DB ready', { dialect: db.dialect });

  // 1b. Backfill container_configs from legacy container.json files.
  // Idempotent — skips groups that already have a config row.
  if (db.dialect === 'sqlite' && controllerPlane()) await backfillContainerConfigs();
  else log.info('Skipping local container.json backfill (non-local central DB or gateway plane)');

  // 1c. Exactly one active host per shared central DB (single-active-host
  // module): the instance lease starts here and a standby waits for
  // leadership before touching anything below — adoption doubles as the
  // takeover resync. Short-circuits on SQLite.
  await startActiveHostGate({ role: HOST_ROLE });

  // 2. Session runtime: prove it is reachable, then reconcile what survived a
  // restart. Adoption replaces the old reap-everything cleanup — a session that
  // is still running keeps running, and only true orphans are stopped.
  if (controllerPlane()) {
    await getSessionDriver().ensureReady?.();
    await adoptRunningSessions();
  }
  getGatewayProvider().reapOrphans?.();

  // 3. Channel adapters
  if (gatewayPlane()) await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
    return {
      onInbound(platformId, threadId, message) {
        routeInbound({
          channelType: adapter.channelType,
          // The one host-side stamping seam: adapters stay instance-blind,
          // the host stamps the receiving instance on every inbound event.
          instance: adapter.instance ?? adapter.channelType,
          platformId,
          threadId,
          message: {
            id: message.id,
            kind: message.kind,
            content: JSON.stringify(message.content),
            timestamp: message.timestamp,
            isMention: message.isMention,
            isGroup: message.isGroup,
          },
        }).catch((err) => {
          log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
        });
      },
      onInboundEvent(event) {
        routeInbound(event).catch((err) => {
          log.error('Failed to route inbound event', {
            sourceAdapter: adapter.channelType,
            targetChannelType: event.channelType,
            err,
          });
        });
      },
      onMetadata(platformId, name, isGroup) {
        log.info('Channel metadata discovered', {
          channelType: adapter.channelType,
          platformId,
          name,
          isGroup,
        });
      },
      onAction(questionId, selectedOption, userId) {
        dispatchResponse({
          questionId,
          value: selectedOption,
          userId,
          channelType: adapter.channelType,
          // platformId/threadId aren't surfaced by the current onAction
          // signature — registered handlers look them up from the
          // pending_question / pending_approval row.
          platformId: '',
          threadId: null,
        }).catch((err) => {
          logResponseDispatchError('Failed to handle question response', questionId, err);
        });
      },
    };
  });

  // 4. Delivery adapter bridge — dispatches to channel adapters by EXACT
  // registry key (instance ?? channelType): a named instance with an
  // offline adapter is never rerouted through a sibling bot. See
  // createChannelDeliveryAdapter in channels/channel-registry.ts.
  if (gatewayPlane()) setDeliveryAdapter(createChannelDeliveryAdapter());

  // 5. Start registered host modules. Imports only registered callbacks; the
  // actual work begins here, after DB + delivery are ready and before polls.
  await startHostModules({ db, signal: hostAbortController.signal });

  // 5b. The instance lease starts inside startActiveHostGate() before
  // adoption (single-active-host module) — see step 1c.

  // 6. Start delivery polls
  if (gatewayPlane()) {
    startActiveDeliveryPoll();
    startSweepDeliveryPoll();
    log.info('Delivery polls started');
  }

  // 7. Start host sweep
  if (controllerPlane()) {
    startHostSweep();
    log.info('Host sweep started');
  }
  // The split controller serves the gateway's durable wake signals and stop
  // intents. In role 'all' the wake seam is a direct delegation — no consumer.
  if (isSplitController()) startWakeSignalConsumer();
  // The split controller also serves the gateway's deferred CLI frames —
  // dev-env and the container runtime answer where they live.
  if (isSplitController()) startCliDispatchConsumer();
  // The split gateway serves the controller's durable DM-resolution requests
  // (the mirror-image seam: adapters live here, provisioning's ncl surface
  // runs there). In role 'all' the in-process adapter answers — no consumer.
  if (isSplitGateway()) startDmResolutionConsumer();

  // 8. Start the `ncl` CLI socket server (data/ncl.sock).
  if (controllerPlane()) {
    await startCliServer();
    await startNclControlServer();
  }

  log.info('NanoClaw running');
  markGatewayReady();
}

/** Graceful shutdown. */
async function shutdown(signal: string): Promise<void> {
  log.info('Shutdown signal received', { signal });
  hostAbortController.abort();
  stopWakeSignalConsumer();
  stopCliDispatchConsumer();
  stopDmResolutionConsumer();
  await stopDeliveryPolls();
  await stopHostSweep();
  await detachGatewaySessions();
  await stopNclControlServer();
  await stopCliServer();
  try {
    await teardownChannelAdapters();
  } finally {
    try {
      await stopHostModules();
    } finally {
      try {
        // Stamp the durable stop only after every Host module has quiesced.
  // Hand leadership off promptly — a standby acquires on its next retry.
  await stopActiveHostGate();
        await stopHostInstanceLease();
      } finally {
        await closeDb();
        // Always reset on graceful shutdown — even if teardown threw, we got here
        // via SIGTERM/SIGINT, not a crash, so the next start shouldn't be counted
        // as one.
        resetCircuitBreaker();
        process.exit(0);
      }
    }
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((err) => {
  log.fatal('Startup failed', { err });
  process.exit(1);
});
