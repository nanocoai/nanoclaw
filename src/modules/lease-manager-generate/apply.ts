/**
 * Guarded handler body for lease_manager_generate.
 *
 * Runs only on an approved replay (see ./guard.ts -- unconditional hold from
 * the container path). Sequence: write the approved plan to a durable audit
 * file, then shell out to the frozen v1 Python generator with that file's
 * path as its sole argument (mirrors apply-write-plan.ps1's -PlanPath --
 * one JSON file in, one RESULT_JSON line out, no stdin timing to get right).
 * The generator runs its own four fail-closed checks internally (allowlist,
 * cross-contamination blocklist, coordinate, template-integrity) before ever
 * writing a file. This handler then independently confirms the reported
 * path actually exists before reporting success -- never just trusts the
 * child process's stdout claim, same principle as lease-manager-write's
 * independent re-read.
 *
 * Lease Manager's container never touches the PDF, the master template, or
 * the Drafts folder for this -- everything below runs host-side. The
 * container can be RO-mounted or unmounted entirely and this still works.
 *
 * Ported from old commit 59de60dc, adapted to await getAgentGroup/
 * notifyAgent (now async) and registerGeneratedDocument (now async).
 * Deliberately NOT exercised by any test that actually shells out to
 * PYTHON_BIN -- same boundary the old commit's own test file drew
 * (lease-manager-generate.test.ts's header comment), and consistent with
 * the explicit instruction not to generate a real lease while porting this.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import { registerGeneratedDocument } from '../lease-document-delivery/registry.js';
import {
  GENERATION_TIMEOUT_MS,
  GENERATOR_SCRIPT_PATH_WSL,
  LEASE_MANAGER_AGENT_GROUP_ID,
  PYTHON_BIN,
} from './config.js';
import type { GenerationPlan } from './request.js';

const execFileAsync = promisify(execFile);

interface GeneratorResult {
  ok: boolean;
  path?: string;
  error?: string;
  error_type?: string;
}

function readResultJson(stdout: string): GeneratorResult {
  const line = stdout.split('\n').find((l) => l.startsWith('RESULT_JSON: '));
  if (!line) throw new Error(`generator produced no RESULT_JSON line. Raw output:\n${stdout}`);
  return JSON.parse(line.slice('RESULT_JSON: '.length));
}

export async function applyLeaseManagerGenerate(payload: Record<string, unknown>, session: Session): Promise<void> {
  // Re-check even though request.ts's precheck already gated this -- this
  // handler is the one that actually shells out and writes a file, so it
  // gets its own independent check rather than trusting the earlier one
  // transitively (same principle as lease-manager-write/apply.ts).
  if (session.agent_group_id !== LEASE_MANAGER_AGENT_GROUP_ID) {
    log.error('lease_manager_generate apply: rejected non-Lease-Manager session at apply time', {
      agentGroupId: session.agent_group_id,
    });
    return;
  }

  const plan = payload.plan as GenerationPlan;
  const requestId = (payload.requestId as string) || `lmg-${Date.now()}`;

  const agentGroup = await getAgentGroup(session.agent_group_id);
  const auditDir = path.join(GROUPS_DIR, agentGroup?.folder ?? 'lease-manager', 'lease-generation-requests');
  fs.mkdirSync(auditDir, { recursive: true });
  const planPath = path.join(auditDir, `${requestId}.json`);
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

  log.info('lease_manager_generate: invoking generator', { requestId, address: plan.property_address });

  let result: GeneratorResult;
  try {
    const { stdout } = await execFileAsync(PYTHON_BIN, [GENERATOR_SCRIPT_PATH_WSL, planPath], {
      timeout: GENERATION_TIMEOUT_MS,
    });
    result = readResultJson(stdout);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error('lease_manager_generate: generator invocation failed', { requestId, err: msg });
    await notifyAgent(
      session,
      `Lease generation approved but the generator failed to run: ${msg}. The generator's own fail-closed checks ` +
        `run before any file is written, so nothing should have been left in Leases/Drafts, but this needs a look.`,
    );
    return;
  }

  if (!result.ok) {
    await notifyAgent(
      session,
      `Lease generation approved but the generator rejected the request (${result.error_type ?? 'error'}): ` +
        `${result.error}. No file was written -- the generator fails closed rather than producing a draft with a ` +
        `problem in it. Please relay this to Kirk via Pepper so the underlying issue can be fixed and retried.`,
    );
    return;
  }

  const outputPath = result.path!;
  if (!fs.existsSync(outputPath)) {
    // Independent verification: don't just trust the child process's stdout
    // claim that a file exists.
    log.error('lease_manager_generate: generator reported success but the file is missing', { requestId, outputPath });
    await notifyAgent(
      session,
      `Lease generation reported success but the expected file could not be found afterward at ${outputPath}. ` +
        `This needs investigation before telling Kirk it's ready.`,
    );
    return;
  }

  const documentReference = await registerGeneratedDocument({
    generationRequestId: requestId,
    filePath: outputPath,
    propertyAddress: plan.property_address,
  });

  await notifyAgent(
    session,
    `Fixed-Term lease PDF generated successfully.\n` +
      `Tenant(s): ${plan.tenant_names.join(' & ')}\n` +
      `Property: ${plan.property_address}\n` +
      `Saved to: ${outputPath}\n\n` +
      `This is an unsigned draft -- signature lines and any signature dates not explicitly supplied are blank. ` +
      `Please relay this to Kirk via Pepper.\n\n` +
      `Document reference for delivery: ${documentReference}\n` +
      `If Kirk wants a copy sent to his Telegram for review, tell Pepper to deliver this exact reference -- ` +
      `never the file path above. Pepper has a tool that only accepts this reference, resolves and re-verifies it ` +
      `host-side, and sends the actual file; it has no way to send an arbitrary path.`,
  );
  log.info('lease_manager_generate: applied', { requestId, outputPath, documentReference });
}
