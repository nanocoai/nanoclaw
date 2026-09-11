/**
 * Workspace composition contract.
 *
 * Today the host composes a group's workspace at spawn time by writing files
 * (CLAUDE.md via claude-md-compose.ts, scaffold + skill links via
 * group-init.ts, container.json materialized from the `container_configs`
 * row). This type freezes what a composer implementation may need: data
 * reachable through the central DB alone. Nothing here may ever require
 * reading the host's filesystem — keeping composition portable to wherever
 * the session's workspace is materialized, with the composition functions
 * themselves carrying unchanged.
 */
import type { AgentGroup, ContainerConfigRow } from './types.js';

export interface WorkspaceComposeInputs {
  /** The agent group row — identity, folder, personality, memory settings. */
  group: AgentGroup;
  /** DB-authoritative container config (source of the container.json projection). */
  containerConfig: ContainerConfigRow;
  /** Resolved group timezone (group override → install global). */
  timezone: string;
}

export interface WorkspaceComposer {
  /**
   * Materialize the workspace under `workspaceRoot` (the group folder).
   * Idempotent — safe to re-run on every session start.
   */
  compose(inputs: WorkspaceComposeInputs, workspaceRoot: string): Promise<void>;
}
