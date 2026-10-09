/**
 * Test-orchestrator seam — pr-factory-core's optional VM-testing surface.
 *
 * Core owns the coordination side (orchestrator.ts: result handling,
 * timeouts, worker wakes) but ships NO VM control plane. The
 * `vm-test-orchestrator` component registers its module here at import time;
 * until then `getTestOrchestrator()` returns null and the send-to-testing
 * flow tells the human/agent that no orchestrator is installed.
 *
 * Cross-component contract: keep `TestRun`, `OrchestratorCallbacks`,
 * `TestOrchestratorModule`, and `registerTestOrchestrator` stable — the
 * vm-test-orchestrator component implements and registers against them.
 */

export interface TestRun {
  prNumber: number;
  repo: string;
  planContent: string;
}

export interface OrchestratorCallbacks {
  onVmReady: (prNumber: number, repo: string, vmHost: string, planContent: string) => Promise<void>;
  onRunFailed: (prNumber: number, repo: string, reason: string, planContent: string) => Promise<void>;
}

export interface TestOrchestratorModule {
  /** Wire the coordination callbacks. Called once by core's initOrchestrator. */
  init(cbs: OrchestratorCallbacks): void;
  /** Queue an approved test plan for execution. */
  submitTest(run: TestRun): void;
  /** Mark a run complete (VM stays alive for investigation). */
  completeRun(prNumber: number): void;
  /** Cancel a run and tear down its VM (timeout path). */
  cancelRun(prNumber: number): Promise<void>;
  /** Destroy the VM for a PR (close/merge path). */
  destroyVm(prNumber: number): Promise<void>;
  /** Tear down all VMs and stop the queue. */
  shutdown(): Promise<void>;
}

let orchestrator: TestOrchestratorModule | null = null;

export function registerTestOrchestrator(mod: TestOrchestratorModule): void {
  orchestrator = mod;
}

export function getTestOrchestrator(): TestOrchestratorModule | null {
  return orchestrator;
}
