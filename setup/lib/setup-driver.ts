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

export class NdjsonSetupDriver implements SetupDriver {
  readonly mode = 'ndjson' as const;
  readonly cancellationSignal: AbortSignal;
  private input: typeof process.stdin | undefined;
  private readonly inputLines: InputLines;
  private readonly abortController = new AbortController();
  private pending: Pending | undefined;
  private isCancelled = false;
  private isTerminal = false;
  private cancelReason: string | undefined;
  private inputChain = Promise.resolve();
  private readonly write: (text: string) => boolean;
  private readonly onSignal = (): void => this.requestCancellation();
  private readonly onInputData = (chunk: Buffer | string): void =>
    this.inputLines.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  private readonly onInputEnd = (): void => {
    this.inputLines.end();
    if (!this.isTerminal) this.requestCancellation('stdin_closed');
  };
  private readonly onInputError = (): void => this.requestCancellation('stdin_error');

  constructor(
    readonly operation: DriverOperation,
    opts: { emitHello?: boolean } = {},
  ) {
    this.cancellationSignal = this.abortController.signal;
    this.write = process.stdout.write.bind(process.stdout);
    if (opts.emitHello !== false) this.emit({ type: 'hello' });
    this.inputLines = new InputLines((line) => {
      this.inputChain = this.inputChain
        .then(() =>
          line === null
            ? this.rejectInput(
                this.pending?.id,
                'command_too_large',
                `Command exceeds the ${MAX_INPUT_LINE_BYTES} byte limit.`,
              )
            : this.handleLine(line),
        )
        .catch((error: unknown) => {
          if (error instanceof DriverCancelled || error instanceof DriverTerminalError) return;
          const message = error instanceof Error ? error.message : String(error);
          try {
            this.error('protocol_input_failed', message);
          } catch (terminal) {
            if (!(terminal instanceof DriverTerminalError)) throw terminal;
          }
        });
    });
    this.input = process.stdin;
    process.stdin.on('data', this.onInputData);
    process.stdin.on('end', this.onInputEnd);
    process.stdin.on('error', this.onInputError);
    process.once('SIGINT', this.onSignal);
    process.once('SIGTERM', this.onSignal);
  }

  async prompt(spec: DriverPrompt): Promise<boolean | string> {
    this.throwIfCancelled();
    if (
      !boundedString(spec.message) ||
      (spec.choices?.length ?? 0) > MAX_COMMAND_ARRAY_LENGTH ||
      spec.choices?.some(
        (choice) =>
          !boundedString(choice.id, 256) ||
          !boundedString(choice.label) ||
          (choice.hint !== undefined && !boundedString(choice.hint)),
      )
    ) {
      this.error('presentation_too_large', 'Prompt presentation exceeds protocol limits.');
    }
    const prompt = {
      id: spec.id ?? randomUUID(),
      kind: spec.kind,
      message: redactSensitiveValues(spec.message),
      sensitive: spec.sensitive ?? spec.kind === 'secret',
      ...(spec.choices
        ? { choices: spec.choices.map(({ id, label }) => ({ id, label: redactSensitiveValues(label) })) }
        : {}),
      ...(spec.default !== undefined && spec.kind !== 'secret' ? { default: spec.default } : {}),
      ...(spec.validation ? { validation: spec.validation } : {}),
    };
    this.emit({ type: 'prompt', prompt });
    const value = await this.wait(prompt.id, async (command) => {
      if (command.type !== 'answer' || command.promptId !== prompt.id) return { done: false };
      const error = validateValue(spec, command.value);
      if (error) {
        this.rejectInput(prompt.id, 'invalid_answer', error);
        return { done: false, rejected: true };
      }
      if (spec.kind === 'secret' && typeof command.value === 'string') registerSensitiveValue(command.value);
      return { done: true, value: command.value };
    });
    return typeof value === 'boolean' ? value : String(value);
  }

  progress(stepId: string, state: ProgressState, label?: string): void {
    if (!boundedString(stepId, 256) || (label !== undefined && !boundedString(label))) {
      this.error('presentation_too_large', 'Progress presentation exceeds protocol limits.');
    }
    this.emit({ type: 'progress', stepId, state, ...(label ? { label: redactSensitiveValues(label) } : {}) });
  }

  display(display: DriverDisplay): void {
    const payload = 'content' in display ? display.content : 'url' in display ? display.url : display.payload;
    if (
      !boundedString(display.id, 256) ||
      !boundedString(payload) ||
      (display.label !== undefined && !boundedString(display.label))
    ) {
      this.error('presentation_too_large', 'Display payload exceeds protocol limits.');
    }
    if (display.kind === 'qr' && payload.length > MAX_COMMAND_STRING_BYTES) {
      this.error('presentation_too_large', 'Display payload exceeds protocol limits.');
    }
    if (display.sensitive) {
      const value = 'content' in display ? display.content : 'url' in display ? display.url : display.payload;
      registerSensitiveValue(value);
    }
    const safeDisplay =
      !display.sensitive && 'url' in display ? { ...display, url: redactSensitiveValues(display.url) } : display;
    this.emit(
      {
        type: 'display',
        display: {
          ...safeDisplay,
          ...(display.label ? { label: redactSensitiveValues(display.label) } : {}),
        },
      },
      display.sensitive,
    );
  }

  clearDisplay(displayId: string): void {
    if (!boundedString(displayId, 256)) this.error('presentation_too_large', 'Display id exceeds protocol limits.');
    this.emit({ type: 'clearDisplay', displayId });
  }

  note(content: string, label?: string): void {
    this.display({ id: randomUUID(), kind: 'text', content, sensitive: false, ...(label ? { label } : {}) });
  }

  log(_level: LogLevel, message: string): void {
    this.note(message);
  }

  intro(message: string): void {
    this.note(message);
  }

  outro(message: string): void {
    this.note(message);
  }

  async externalAction(
    action: ExternalAction,
    verify: () => boolean | Promise<boolean>,
  ): Promise<ExternalActionResult> {
    this.throwIfCancelled();
    if (!boundedString(action.title) || !boundedString(action.id ?? '', 256)) {
      this.error('invalid_external_action', 'External action presentation exceeds protocol limits.');
    }
    if (action.kind === 'openURL' && new URL(action.url).protocol !== 'https:') {
      this.error('invalid_external_action', 'openURL actions require an HTTPS URL.');
    }
    if (action.kind === 'openURL' && !boundedString(action.url))
      this.error('invalid_external_action', 'External action URL exceeds protocol limits.');
    if (action.kind === 'startApplication' && !boundedString(action.application, 256))
      this.error('invalid_external_action', 'Application name exceeds protocol limits.');
    if (
      action.kind === 'systemPermission' &&
      (action.instructions.length > MAX_COMMAND_ARRAY_LENGTH ||
        action.instructions.some((instruction) => !boundedString(instruction)))
    ) {
      this.error('invalid_external_action', 'Permission instructions exceed protocol limits.');
    }
    const withId = { ...action, id: action.id ?? randomUUID() };
    this.emit({ type: 'externalAction', action: withId });
    const value = await this.wait(withId.id, async (command) => {
      if (command.type !== 'externalActionCompleted' || command.actionId !== withId.id) {
        return { done: false };
      }
      if (command.result === 'declined' || command.result === 'unsupported')
        return { done: true, value: command.result };
      if (!(await verify())) {
        this.rejectInput(withId.id, 'postcondition_failed', 'The required postcondition is not satisfied.');
        return { done: false, rejected: true };
      }
      return { done: true, value: 'attempted' };
    });
    return value as ExternalActionResult;
  }

  async waitForUninstall(
    plan: UninstallPlan,
    validate: (choices: Map<UninstallGroup, UninstallChoice>) => string | undefined,
  ): Promise<Map<UninstallGroup, UninstallChoice>> {
    if (!validUninstallPlan(plan)) {
      this.error('presentation_too_large', 'Uninstall plan presentation exceeds protocol limits.');
    }
    for (const artifact of plan.artifacts) {
      this.emit({ type: 'uninstallPlanItem', planId: plan.id, artifact });
    }
    this.emit({
      type: 'uninstallPlan',
      plan: { id: plan.id, groups: plan.groups },
    });
    const value = await this.wait(plan.id, async (command) => {
      if (command.type !== 'applyUninstall' || command.planId !== plan.id) return { done: false };
      if (!Array.isArray(command.choices)) {
        this.rejectInput(plan.id, 'invalid_uninstall_choices', 'Expected a choices array.');
        return { done: false, rejected: true };
      }
      const choices = new Map<UninstallGroup, UninstallChoice>();
      for (const entry of command.choices) {
        if (!isRecord(entry)) {
          this.rejectInput(plan.id, 'invalid_uninstall_choices', 'Every choice must be an object.');
          return { done: false, rejected: true };
        }
        const groupId = entry.groupId;
        const choice = entry.choice;
        if (!isUninstallGroup(groupId)) {
          this.rejectInput(plan.id, 'invalid_uninstall_choices', 'Unknown uninstall group.');
          return { done: false, rejected: true };
        }
        if (choice !== 'preserve' && choice !== 'remove') {
          this.rejectInput(plan.id, 'invalid_uninstall_choices', 'Unknown uninstall choice.');
          return { done: false, rejected: true };
        }
        const group = groupId;
        if (choices.has(group)) {
          this.rejectInput(plan.id, 'duplicate_uninstall_group', `Duplicate choice for ${group}.`);
          return { done: false, rejected: true };
        }
        choices.set(group, choice);
      }
      if (choices.size !== plan.groups.length || plan.groups.some((group) => !choices.has(group.id))) {
        this.rejectInput(plan.id, 'incomplete_uninstall_choices', 'Supply exactly one choice for every group.');
        return { done: false, rejected: true };
      }
      const error = validate(choices);
      if (error) {
        this.rejectInput(plan.id, 'unsafe_uninstall_choices', error);
        return { done: false, rejected: true };
      }
      return { done: true, value: choices };
    });
    if (!(value instanceof Map)) throw new Error('invalid uninstall command result');
    return value;
  }

  uninstallAction(result: UninstallActionResult): void {
    if (!validUninstallResult(result)) {
      this.error('presentation_too_large', 'Uninstall action presentation exceeds protocol limits.');
    }
    this.emit({ type: 'uninstallAction', result });
  }

  throwIfCancelled(): void {
    if (this.isCancelled) throw new DriverCancelled(this.cancelReason);
  }

  error(code: string, message: string, recovery: Recovery[] = [], stepId?: string): never {
    if (
      !boundedString(code, 256) ||
      !boundedString(message) ||
      (stepId !== undefined && !boundedString(stepId, 256)) ||
      !validRecovery(recovery)
    ) {
      code = 'presentation_too_large';
      message = 'Error presentation exceeds protocol limits.';
      recovery = [];
      stepId = undefined;
    }
    this.terminate({
      type: 'error',
      code,
      ...(stepId ? { stepId } : {}),
      message: redactSensitiveValues(message),
      recovery,
    });
    throw new DriverTerminalError(1);
  }

  completeSetup(receipt: SetupReceipt): void {
    this.throwIfCancelled();
    this.terminate({ type: 'complete', receipt });
  }

  completeUninstall(receipt: UninstallReceipt): void {
    this.throwIfCancelled();
    if (
      !receipt.results.every(validUninstallResult) ||
      !receipt.remaining.every(validUninstallArtifact) ||
      !receipt.checkoutRemoval.blockers.every((blocker) => boundedString(blocker)) ||
      !boundedString(receipt.completedAt, 256)
    ) {
      this.error('presentation_too_large', 'Uninstall receipt presentation exceeds protocol limits.');
    }
    for (const artifact of receipt.remaining) {
      this.emit({ type: 'uninstallReceiptItem', section: 'remaining', artifact });
    }
    this.terminate({
      type: 'complete',
      receipt: {
        version: receipt.version,
        outcome: receipt.outcome,
        checkoutRemoval: receipt.checkoutRemoval,
        completedAt: receipt.completedAt,
      },
    });
  }

  cancelled(
    details: {
      lastStepId?: string;
      results?: UninstallActionResult[];
      remaining?: Artifact[];
    } = {},
  ): void {
    if (this.operation !== 'uninstall') {
      this.terminate({ type: 'cancelled', ...details });
      return;
    }
    if (
      (details.results !== undefined && !details.results.every(validUninstallResult)) ||
      (details.remaining !== undefined && !details.remaining.every(validUninstallArtifact)) ||
      (details.lastStepId !== undefined && !boundedString(details.lastStepId, 256))
    ) {
      this.error('presentation_too_large', 'Uninstall cancellation details exceed protocol limits.');
    }
    for (const artifact of details.remaining ?? []) {
      this.emit({ type: 'uninstallReceiptItem', section: 'remaining', artifact });
    }
    this.terminate({
      type: 'cancelled',
      ...(details.lastStepId ? { lastStepId: details.lastStepId } : {}),
    });
  }

  handoff(): void {
    this.input?.off('data', this.onInputData);
    this.input?.off('end', this.onInputEnd);
    this.input?.off('error', this.onInputError);
    this.input?.pause();
    this.input = undefined;
  }

  close(): void {
    this.handoff();
    process.off('SIGINT', this.onSignal);
    process.off('SIGTERM', this.onSignal);
  }

  private emit(event: Record<string, unknown>, allowSensitive = false): void {
    if (this.isTerminal) return;
    this.writeEvent(event, allowSensitive);
  }

  private terminate(event: Record<string, unknown>): void {
    if (this.isTerminal) return;
    this.isTerminal = true;
    this.writeEvent(event);
    this.close();
  }

  private writeEvent(event: Record<string, unknown>, allowSensitive = false): void {
    const payload = allowSensitive ? event : (redactProtocolPresentation(event) as Record<string, unknown>);
    this.write(JSON.stringify({ protocol: DRIVER_PROTOCOL, operation: this.operation, ...payload }) + '\n');
  }

  private wait(id: string, accept: Pending['accept']): Promise<unknown> {
    if (this.pending) throw new Error('driver already has a pending item');
    return new Promise((resolve, reject) => {
      this.pending = { id, accept, resolve, reject };
    });
  }

  private async handleLine(line: string): Promise<void> {
    if (this.isTerminal) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.rejectInput(undefined, 'invalid_json', 'Command must be one JSON object.');
      return;
    }
    const command = parseCommand(parsed, this.operation);
    if ('error' in command) {
      const code =
        isRecord(parsed) && parsed.protocol === DRIVER_PROTOCOL && parsed.operation === this.operation
          ? typeof parsed.type === 'string' &&
            !['answer', 'externalActionCompleted', 'applyUninstall', 'cancel'].includes(parsed.type)
            ? 'unknown_command'
            : 'invalid_command'
          : 'wrong_envelope';
      this.rejectInput(command.itemId, code, command.error);
      return;
    }
    if (command.type === 'cancel') {
      this.requestCancellation(command.reason);
      return;
    }
    const pending = this.pending;
    if (!pending) {
      this.rejectInput(this.commandItemId(command), 'stale_command', 'There is no matching pending item.');
      return;
    }
    const result = await pending.accept(command);
    if (this.isTerminal || this.isCancelled) return;
    if (!result.done) {
      if (!result.rejected) {
        this.rejectInput(this.commandItemId(command), 'stale_command', 'Command does not match the pending item.');
      }
      return;
    }
    this.pending = undefined;
    pending.resolve(result.value);
  }

  private commandItemId(command: Record<string, unknown>): string | undefined {
    for (const key of ['promptId', 'actionId', 'planId']) {
      if (typeof command[key] === 'string') return command[key];
    }
    return undefined;
  }

  private rejectInput(itemId: string | undefined, code: string, message: string): void {
    this.emit({ type: 'inputRejected', ...(itemId ? { itemId } : {}), code, message });
  }

  private requestCancellation(reason?: string): void {
    if (this.isTerminal) return;
    this.isCancelled = true;
    this.cancelReason = reason;
    this.abortController.abort(reason);
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(new DriverCancelled(this.cancelReason));
  }
}

export class DriverTerminalError extends Error {
  constructor(readonly exitCode: 0 | 1 | 2) {
    super(`driver terminated with exit ${exitCode}`);
  }
}

export function createSetupDriver(operation: DriverOperation): SetupDriver {
  return process.env.NANOCLAW_PROTOCOL === DRIVER_PROTOCOL
    ? new NdjsonSetupDriver(operation, {
        emitHello: process.env.NANOCLAW_DRIVER_SHELL_HELLO !== '1' && process.env.NANOCLAW_DRIVER_CONTINUATION !== '1',
      })
    : new TerminalSetupDriver(operation);
}
