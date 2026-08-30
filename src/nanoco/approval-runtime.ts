import type { DbDriver } from '../db/driver.js';
import { getDeliveryAdapter } from '../delivery.js';
import { readEnvFile } from '../env.js';
import { onHostShutdown, onHostStart } from '../host-lifecycle.js';
import { gatewayPlane } from '../modules/process-split/role.js';
import { registerResponseHandler } from '../response-registry.js';
import { ensureUserDm } from '../modules/permissions/user-dm.js';
import { GatewayApprovalCards } from './approval-cards.js';
import './approval-question-render.js';
import { GatewayApprovalStore } from './approval-store.js';
import { HttpsGatewayApprovalTransport } from './approval-transport.js';
import { GatewayApprovalAdapter } from './gateway-approval-adapter.js';

const CONFIG_KEYS = [
  'NANOCO_DEPLOYMENT_ID',
  'NANOCO_GATEWAY_CONTROL_URL',
  'NANOCO_GATEWAY_CONTROL_SERVER_NAME',
  'NANOCO_GATEWAY_CA',
  'NANOCO_DEPLOYMENT_CERT',
  'NANOCO_DEPLOYMENT_KEY',
] as const;

let activeAdapter: GatewayApprovalAdapter | null = null;
let runningAdapter: RunningGatewayApprovalAdapter | null = null;

// Dedicated dispatch: Gateway cards never enter pending_approvals or its
// role/admin-authorized continuation handlers.
registerResponseHandler(async (payload) => activeAdapter?.handleClick(payload) ?? false);

export interface RunningGatewayApprovalAdapter {
  stop(): Promise<void>;
}

/** Start the host-only adapter when the existing deployment trust is configured. */
export function startConfiguredGatewayApprovalAdapter(db: DbDriver): RunningGatewayApprovalAdapter | null {
  const dotenv = readEnvFile([...CONFIG_KEYS]);
  const configured = Object.fromEntries(
    CONFIG_KEYS.map((key) => [key, process.env[key]?.trim() || dotenv[key]?.trim() || '']),
  ) as Record<(typeof CONFIG_KEYS)[number], string>;
  if (CONFIG_KEYS.every((key) => !configured[key])) return null;
  const missing = CONFIG_KEYS.filter((key) => !configured[key]);
  if (missing.length > 0) {
    throw new Error(`NanoCo approval configuration is incomplete: ${missing.join(', ')}`);
  }
  if (activeAdapter) throw new Error('NanoCo Gateway approval adapter is already running');

  const store = new GatewayApprovalStore(db, configured.NANOCO_DEPLOYMENT_ID);
  const transport = new HttpsGatewayApprovalTransport({
    deploymentId: configured.NANOCO_DEPLOYMENT_ID,
    controlUrl: configured.NANOCO_GATEWAY_CONTROL_URL,
    controlServerName: configured.NANOCO_GATEWAY_CONTROL_SERVER_NAME,
    gatewayCaPath: configured.NANOCO_GATEWAY_CA,
    deploymentCertificatePath: configured.NANOCO_DEPLOYMENT_CERT,
    deploymentPrivateKeyPath: configured.NANOCO_DEPLOYMENT_KEY,
  });
  const cards = new GatewayApprovalCards(store, {
    resolveBinding: store,
    resolveDm: (userId) => ensureUserDm(userId, { privacySafeLogs: true }),
    deliveryAdapter: getDeliveryAdapter,
    decisionReady: () => adapter.decisionReady(),
  });
  const adapter = new GatewayApprovalAdapter(store, cards, transport);
  activeAdapter = adapter;
  adapter.start();

  return {
    async stop(): Promise<void> {
      if (activeAdapter === adapter) activeAdapter = null;
      await adapter.stop();
    },
  };
}

onHostStart(({ db }) => {
  if (!gatewayPlane()) return;
  runningAdapter = startConfiguredGatewayApprovalAdapter(db);
});

onHostShutdown(async () => {
  const adapter = runningAdapter;
  runningAdapter = null;
  await adapter?.stop();
});
