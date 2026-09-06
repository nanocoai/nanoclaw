import { randomUUID } from 'node:crypto';

import * as p from '@clack/prompts';

import { brightSelect } from './bright-select.js';
import { redactSensitiveValues, registerSensitiveValue } from './redaction.js';

export const DRIVER_PROTOCOL = 'nanoclaw.driver.v1' as const;

export type DriverOperation = 'setup' | 'uninstall';
export type ProgressState = 'pending' | 'running' | 'succeeded' | 'failed';
export type UninstallGroup = 'service' | 'data' | 'user' | 'onecli';
export type UninstallChoice = 'preserve' | 'remove';
export type ActionOutcome = 'removed' | 'preserved' | 'failed' | 'untouched' | 'alreadyAbsent';

export type Validation = {
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
};

export type DriverPrompt = {
  id?: string;
  kind: 'confirm' | 'singleChoice' | 'text' | 'secret';
  message: string;
  sensitive?: boolean;
  choices?: Array<{ id: string; label: string; hint?: string }>;
  default?: boolean | string;
  /** Terminal-only hint; deliberately absent from the wire schema. */
  placeholder?: string;
  /** Terminal-only search UI; deliberately absent from the wire schema. */
  searchable?: boolean;
  validation?: Validation;
  /** Driver-side validation that is enforced but not serialized on the wire. */
  validateValue?: (value: boolean | string) => string | undefined;
};

export type DriverDisplay =
  | { id: string; kind: 'text' | 'code'; content: string; sensitive: boolean; label?: string }
  | { id: string; kind: 'url'; url: string; label: string; sensitive: boolean }
  | { id: string; kind: 'qr'; payload: string; sensitive: boolean; label?: string };

export type ExternalAction =
  | { id?: string; kind: 'openURL'; title: string; url: string }
  | { id?: string; kind: 'startApplication'; title: string; application: string }
  | { id?: string; kind: 'systemPermission'; title: string; instructions: string[] };

export type ExternalActionResult = 'attempted' | 'declined' | 'unsupported';

export type Recovery = { kind: 'rerun'; args: string[] } | { kind: 'manual'; title: string; instructions: string[] };

export type Artifact = {
  id: string;
  kind: string;
  label: string;
  location: string;
  disposition: 'owned' | 'shared' | 'external' | 'uninspectable' | 'alreadyAbsent';
  decisionGroup?: UninstallGroup;
};

export type UninstallPlan = {
  id: string;
  groups: Array<{
    id: UninstallGroup;
    label: string;
    description: string;
    default: 'preserve';
    choices: ['preserve', 'remove'];
  }>;
  artifacts: Artifact[];
};

export type UninstallActionResult = {
  actionId: string;
  artifactId: string;
  outcome: ActionOutcome;
  error?: { code: string; message: string };
};

export type UninstallReceipt = {
  version: 1;
  outcome: 'success' | 'incomplete';
  results: UninstallActionResult[];
  remaining: Artifact[];
  checkoutRemoval: {
    safe: boolean;
    blockers: string[];
  };
  completedAt: string;
};

export type SetupReceipt = {
  version: 1;
  service: {
    state: 'running';
    manager: 'launchd' | 'systemd-user' | 'systemd-system' | 'pidfile';
    checkoutRoot: string;
  };
  health: { status: 'healthy' };
  resources: {
    groups: { state: 'loaded' | 'empty'; count: number };
    policies: { state: 'loaded' | 'empty'; count: number };
    skills: { state: 'loaded' | 'empty'; count: number };
  };
  completedAt: string;
};

export class DriverCancelled extends Error {
  constructor(readonly reason?: string) {
    super('driver cancelled');
  }
}

type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'step' | 'message';

export interface SetupDriver {
  readonly mode: 'terminal' | 'ndjson';
  readonly operation: DriverOperation;
  readonly cancellationSignal?: AbortSignal;
  prompt(spec: DriverPrompt): Promise<boolean | string>;
  progress(stepId: string, state: ProgressState, label?: string): void;
  display(display: DriverDisplay): void;
  clearDisplay(displayId: string): void;
  note(content: string, label?: string): void;
  log(level: LogLevel, message: string): void;
  intro(message: string): void;
  outro(message: string): void;
  externalAction(action: ExternalAction, verify: () => boolean | Promise<boolean>): Promise<ExternalActionResult>;
  waitForUninstall(
    plan: UninstallPlan,
    validate: (choices: Map<UninstallGroup, UninstallChoice>) => string | undefined,
  ): Promise<Map<UninstallGroup, UninstallChoice>>;
  uninstallAction(result: UninstallActionResult): void;
  throwIfCancelled(): void;
  error(code: string, message: string, recovery?: Recovery[], stepId?: string): never;
  completeSetup(receipt: SetupReceipt): void;
  completeUninstall(receipt: UninstallReceipt): void;
  cancelled(details?: { lastStepId?: string; results?: UninstallActionResult[]; remaining?: Artifact[] }): void;
  handoff(): void;
  close(): void;
}

function validateValue(spec: DriverPrompt, value: unknown): string | undefined {
  if (spec.kind === 'confirm') return typeof value === 'boolean' ? undefined : 'Expected a boolean.';
  if (typeof value !== 'string') return 'Expected a string.';
  if (spec.kind === 'singleChoice') {
    return spec.choices?.some((choice) => choice.id === value) ? undefined : 'Unknown choice.';
  }
  const validation = spec.validation;
  if (validation?.required && value.length === 0) return 'A value is required.';
  if (validation?.minLength !== undefined && value.length < validation.minLength) {
    return `Value must be at least ${validation.minLength} characters.`;
  }
  if (validation?.maxLength !== undefined && value.length > validation.maxLength) {
    return `Value must be at most ${validation.maxLength} characters.`;
  }
  if (validation?.pattern !== undefined) {
    try {
      if (!new RegExp(validation.pattern).test(value)) return 'Value does not match the expected format.';
    } catch {
      return 'Prompt validation is invalid.';
    }
  }
  return spec.validateValue?.(value);
}

function isUninstallGroup(value: unknown): value is UninstallGroup {
  return typeof value === 'string' && ['service', 'data', 'user', 'onecli'].includes(value);
}

const PRESENTATION_FIELDS = new Set(['content', 'instructions', 'label', 'location', 'message', 'payload', 'title']);

function redactProtocolPresentation(value: unknown, field?: string): unknown {
  if (typeof value === 'string') {
    return field && PRESENTATION_FIELDS.has(field) ? redactSensitiveValues(value) : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactProtocolPresentation(item, field));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactProtocolPresentation(item, key)]));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
