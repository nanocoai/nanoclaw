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

export class TerminalSetupDriver implements SetupDriver {
  readonly mode = 'terminal' as const;

  constructor(readonly operation: DriverOperation) {}

  async prompt(spec: DriverPrompt): Promise<boolean | string> {
    const validate = (value: string | undefined): string | undefined => validateValue(spec, value ?? '');
    let answer: boolean | string | symbol;
    if (spec.kind === 'confirm') {
      answer = await p.confirm({
        message: spec.message,
        initialValue: spec.default === undefined ? true : spec.default === true,
      });
    } else if (spec.kind === 'singleChoice') {
      const options = (spec.choices ?? []).map(({ id, label, hint }) => ({ value: id, label, hint }));
      answer = spec.searchable
        ? await p.autocomplete({
            message: spec.message,
            options,
            initialValue: typeof spec.default === 'string' ? spec.default : undefined,
            maxItems: 5,
            placeholder: spec.placeholder,
          })
        : await brightSelect({
            message: spec.message,
            options,
            initialValue: typeof spec.default === 'string' ? spec.default : undefined,
          });
    } else if (spec.kind === 'secret') {
      answer = await p.password({ message: spec.message, clearOnError: true, validate });
    } else {
      answer = await p.text({
        message: spec.message,
        placeholder: spec.placeholder,
        defaultValue: typeof spec.default === 'string' ? spec.default : undefined,
        validate,
      });
    }
    if (p.isCancel(answer)) throw new DriverCancelled();
    const value = typeof answer === 'boolean' ? answer : String(answer);
    if (spec.kind === 'secret' && typeof value === 'string') registerSensitiveValue(value);
    return value;
  }

  progress(_stepId: string, _state: ProgressState, _label?: string): void {}

  display(display: DriverDisplay): void {
    const content = 'content' in display ? display.content : 'url' in display ? display.url : display.payload;
    p.note(content, display.label);
  }

  clearDisplay(_displayId: string): void {}

  note(content: string, label?: string): void {
    p.note(content, label);
  }

  log(level: LogLevel, message: string): void {
    p.log[level](message);
  }

  intro(message: string): void {
    p.intro(message);
  }

  outro(message: string): void {
    p.outro(message);
  }

  async externalAction(
    action: ExternalAction,
    verify: () => boolean | Promise<boolean>,
  ): Promise<ExternalActionResult> {
    if (action.kind === 'openURL') {
      const answer = await this.prompt({
        kind: 'confirm',
        message: `Open ${action.url} in your browser?`,
        default: true,
      });
      if (answer !== true) return 'declined';
    }
    return (await verify()) ? 'attempted' : 'unsupported';
  }

  async waitForUninstall(): Promise<Map<UninstallGroup, UninstallChoice>> {
    throw new Error('terminal uninstall collects choices through its existing prompts');
  }

  uninstallAction(_result: UninstallActionResult): void {}

  throwIfCancelled(): void {}

  error(_code: string, message: string, _recovery: Recovery[] = [], _stepId?: string): never {
    throw new Error(message);
  }

  completeSetup(_receipt: SetupReceipt): void {}
  completeUninstall(_receipt: UninstallReceipt): void {}

  cancelled(): void {
    p.cancel(this.operation === 'setup' ? 'Setup cancelled.' : 'Uninstall cancelled.');
  }

  handoff(): void {}
  close(): void {}
}

type Pending = {
  id: string;
  accept(command: Record<string, unknown>): Promise<{ done: boolean; rejected?: boolean; value?: unknown }>;
  resolve(value: unknown): void;
  reject(error: Error): void;
};

const MAX_INPUT_LINE_BYTES = 1_048_576;
const MAX_COMMAND_STRING_BYTES = 64 * 1024;
const MAX_COMMAND_ARRAY_LENGTH = 64;

type DriverCommand =
  | {
      protocol: typeof DRIVER_PROTOCOL;
      operation: DriverOperation;
      type: 'answer';
      promptId: string;
      value: boolean | string;
    }
  | {
      protocol: typeof DRIVER_PROTOCOL;
      operation: DriverOperation;
      type: 'externalActionCompleted';
      actionId: string;
      result: ExternalActionResult;
    }
  | {
      protocol: typeof DRIVER_PROTOCOL;
      operation: DriverOperation;
      type: 'applyUninstall';
      planId: string;
      choices: Array<{ groupId: UninstallGroup; choice: UninstallChoice }>;
    }
  | { protocol: typeof DRIVER_PROTOCOL; operation: DriverOperation; type: 'cancel'; reason?: string };

function boundedString(value: unknown, maxBytes = MAX_COMMAND_STRING_BYTES): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function validUninstallArtifact(artifact: Artifact): boolean {
  return (
    boundedString(artifact.id, 256) &&
    boundedString(artifact.kind, 256) &&
    boundedString(artifact.label) &&
    boundedString(artifact.location) &&
    (artifact.decisionGroup === undefined || isUninstallGroup(artifact.decisionGroup))
  );
}

function validUninstallResult(result: UninstallActionResult): boolean {
  return (
    boundedString(result.actionId, 256) &&
    boundedString(result.artifactId, 256) &&
    (result.error === undefined || (boundedString(result.error.code, 256) && boundedString(result.error.message)))
  );
}

function validUninstallPlan(plan: UninstallPlan): boolean {
  return (
    boundedString(plan.id, 256) &&
    plan.groups.length <= MAX_COMMAND_ARRAY_LENGTH &&
    plan.groups.every(
      (group) =>
        isUninstallGroup(group.id) &&
        boundedString(group.label) &&
        boundedString(group.description) &&
        group.default === 'preserve' &&
        group.choices.length === 2 &&
        group.choices.every((choice) => choice === 'preserve' || choice === 'remove'),
    ) &&
    plan.artifacts.every(validUninstallArtifact)
  );
}

function validRecovery(recovery: Recovery[]): boolean {
  return (
    recovery.length <= MAX_COMMAND_ARRAY_LENGTH &&
    recovery.every((item) =>
      item.kind === 'rerun'
        ? item.args.length <= MAX_COMMAND_ARRAY_LENGTH && item.args.every((arg) => boundedString(arg))
        : boundedString(item.title) &&
          item.instructions.length <= MAX_COMMAND_ARRAY_LENGTH &&
          item.instructions.every((instruction) => boundedString(instruction)),
    )
  );
}

function parseCommand(value: unknown, operation: DriverOperation): DriverCommand | { error: string; itemId?: string } {
  if (!isRecord(value)) return { error: 'Command must be a JSON object.' };
  if (value.protocol !== DRIVER_PROTOCOL || value.operation !== operation) {
    return { error: 'Protocol or operation does not match this run.' };
  }
  const type = value.type;
  if (type === 'answer') {
    if (!boundedString(value.promptId, 256)) return { error: 'promptId must be a bounded string.' };
    if (!(typeof value.value === 'boolean' || boundedString(value.value)))
      return { error: 'answer value is invalid.', itemId: value.promptId };
    return { protocol: DRIVER_PROTOCOL, operation, type, promptId: value.promptId, value: value.value };
  }
  if (type === 'externalActionCompleted') {
    if (!boundedString(value.actionId, 256)) return { error: 'actionId must be a bounded string.' };
    const result = value.result;
    if (result !== 'attempted' && result !== 'declined' && result !== 'unsupported') {
      return { error: 'result must be attempted, declined, or unsupported.', itemId: value.actionId };
    }
    return { protocol: DRIVER_PROTOCOL, operation, type, actionId: value.actionId, result };
  }
  if (type === 'applyUninstall') {
    if (
      !boundedString(value.planId, 256) ||
      !Array.isArray(value.choices) ||
      value.choices.length > MAX_COMMAND_ARRAY_LENGTH
    ) {
      return {
        error: 'Uninstall choices are invalid.',
        itemId: typeof value.planId === 'string' ? value.planId : undefined,
      };
    }
    const choices: Array<{ groupId: UninstallGroup; choice: UninstallChoice }> = [];
    for (const entry of value.choices) {
      if (
        !isRecord(entry) ||
        !isUninstallGroup(entry.groupId) ||
        (entry.choice !== 'preserve' && entry.choice !== 'remove')
      ) {
        return { error: 'Uninstall choices are invalid.', itemId: value.planId };
      }
      choices.push({ groupId: entry.groupId, choice: entry.choice });
    }
    return { protocol: DRIVER_PROTOCOL, operation, type, planId: value.planId, choices };
  }
  if (type === 'cancel') {
    if (value.reason !== undefined && !boundedString(value.reason, 4 * 1024))
      return { error: 'Cancel reason is invalid.' };
    return {
      protocol: DRIVER_PROTOCOL,
      operation,
      type,
      ...(value.reason === undefined ? {} : { reason: value.reason }),
    };
  }
  return { error: 'Unknown command type.' };
}

class InputLines {
  private buffer = Buffer.alloc(0);
  private discarding = false;
  constructor(private readonly onLine: (line: string | null) => void) {}

  push(chunk: Buffer): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      if (this.discarding) {
        if (newline !== -1) this.discarding = false;
      } else if (this.buffer.length + part.length > MAX_INPUT_LINE_BYTES) {
        this.buffer = Buffer.alloc(0);
        this.discarding = newline === -1;
        this.onLine(null);
      } else {
        this.buffer = Buffer.concat([this.buffer, part]);
        if (newline !== -1) {
          const line = this.buffer.toString('utf8').replace(/\r$/, '');
          this.buffer = Buffer.alloc(0);
          this.onLine(line);
        }
      }
      if (newline === -1) break;
      start = newline + 1;
    }
  }

  end(): void {
    if (this.discarding) return;
    if (this.buffer.length > 0) this.onLine(this.buffer.toString('utf8'));
    this.buffer = Buffer.alloc(0);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
