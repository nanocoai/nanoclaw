# NanoClaw setup driver protocol v1

`nanoclaw.driver.v1` lets a client render setup or uninstall without parsing
terminal output. NanoClaw remains the state machine and owns validation, side
effects, and completion checks.

## Starting a session

```sh
bash nanoclaw.sh --protocol nanoclaw.driver.v1
bash nanoclaw.sh --uninstall --protocol nanoclaw.driver.v1
```

Without `--protocol`, behavior is unchanged. An unsupported protocol fails
before setup output or mutation.

The process writes one JSON object per line to stdout and reads one JSON object
per line from stdin. Stderr is empty during a protocol session. Every object has
this envelope:

```ts
type Envelope = {
  protocol: 'nanoclaw.driver.v1';
  operation: 'setup' | 'uninstall';
};
```

The first event is `hello`. It is emitted once across the shell bootstrap and
TypeScript handoff.

```json
{"protocol":"nanoclaw.driver.v1","operation":"setup","type":"hello"}
```

Exit codes are `0` for complete, `1` for error or incomplete uninstall, and `2`
for cancellation.

## Renderer parity

Terminal and protocol mode call the same setup flow. `auto.ts` defines ordering,
choices, side effects, and postconditions through `SetupDriver`; each renderer
only presents those operations. Parity tests run the production first-agent
choice through both renderers and exercise production template stamping through
the real socket contract. A parity lint prevents direct prompt primitives from
returning to `auto.ts`.

Transport still creates three intentional differences. Protocol mode requires
structured healthy completion, transports secrets on stdin, and removes
terminal-only back navigation because the app owns its preflight navigation.
These differences do not create a second setup policy or runner.

## Commands

Only the current outstanding item accepts an answer. A command with a different
ID, or a command sent when nothing is pending, is rejected as `stale_command`.
There is no replay cache or command fingerprint protocol.

```ts
type Command = Envelope & (
  | { type: 'answer'; promptId: string; value: boolean | string }
  | {
      type: 'externalActionCompleted';
      actionId: string;
      result: 'attempted' | 'declined' | 'unsupported';
    }
  | {
      type: 'applyUninstall';
      planId: string;
      choices: Array<{
        groupId: 'service' | 'data' | 'user' | 'onecli';
        choice: 'preserve' | 'remove';
      }>;
    }
  | { type: 'cancel'; reason?: string }
);
```

Each command string is bounded to 64 KiB, arrays are bounded to 64 entries,
and an input line is bounded to 1 MiB.

## Common events

### Progress

```ts
type ProgressEvent = Envelope & {
  type: 'progress';
  stepId: string;
  state: 'pending' | 'running' | 'succeeded' | 'failed';
  label?: string;
};
```

A step that successfully falls back to another supported path is `succeeded`.
There is no `skipped` wire state.

### Prompt

```ts
type PromptEvent = Envelope & {
  type: 'prompt';
  prompt: {
    id: string;
    kind: 'confirm' | 'singleChoice' | 'text' | 'secret';
    message: string;
    sensitive: boolean;
    choices?: Array<{ id: string; label: string }>;
    default?: boolean | string;
    validation?: {
      required?: boolean;
      minLength?: number;
      maxLength?: number;
      pattern?: string;
    };
  };
};
```

The client answers with `answer`. A secret answer must arrive on protocol stdin.
Secrets are forbidden in launch arguments and environment variables. A client
must not log or persist a prompt marked `sensitive`.

### Display

```ts
type Display =
  | { id: string; kind: 'text' | 'code'; content: string; label?: string; sensitive: boolean }
  | { id: string; kind: 'url'; url: string; label: string; sensitive: boolean }
  | { id: string; kind: 'qr'; payload: string; label?: string; sensitive: boolean };

type DisplayEvent = Envelope & { type: 'display'; display: Display };
type ClearDisplayEvent = Envelope & { type: 'clearDisplay'; displayId: string };
```

Sensitive displays are the only events allowed to carry a pairing code or
verification URL containing a code. Render them without persistence and clear
them on `clearDisplay` or process exit.

### External action

```ts
type ExternalActionEvent = Envelope & {
  type: 'externalAction';
  action:
    | { id: string; kind: 'openURL'; title: string; url: string }
    | { id: string; kind: 'startApplication'; title: string; application: string }
    | { id: string; kind: 'systemPermission'; title: string; instructions: string[] };
};
```

An `openURL` action always uses HTTPS. The client reports only whether it
attempted, declined, or could not support the action. NanoClaw checks any
required postcondition itself.

### Rejected input

```ts
type InputRejectedEvent = Envelope & {
  type: 'inputRejected';
  itemId?: string;
  code: string;
  message: string;
};
```

Rejection is nonterminal. The current item remains pending unless another valid
command has already resolved it.

### Error and cancellation

```ts
type Recovery =
  | { kind: 'rerun'; args: string[] }
  | { kind: 'manual'; title: string; instructions: string[] };

type ErrorEvent = Envelope & {
  type: 'error';
  code: string;
  stepId?: string;
  message: string;
  recovery: Recovery[];
};

type CancelledEvent = Envelope & {
  type: 'cancelled';
  lastStepId?: string;
};
```

`error` and `cancelled` are terminal. Closing stdin requests cancellation. During
uninstall, NanoClaw completes the current atomic action and starts no new action.

## Setup completion

```ts
type SetupCompleteEvent = Envelope & {
  type: 'complete';
  receipt: {
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
};
```

Setup completes only after service ownership and structured host health are
verified.

## Uninstall

Uninstall is plan-first and defaults every group to preservation. NanoClaw emits
each artifact as it is discovered, then emits the actionable plan header.

```ts
type Artifact = {
  id: string;
  kind: string;
  label: string;
  location: string;
  disposition: 'owned' | 'shared' | 'external' | 'uninspectable' | 'alreadyAbsent';
  decisionGroup?: 'service' | 'data' | 'user' | 'onecli';
};

type UninstallPlanItemEvent = Envelope & {
  type: 'uninstallPlanItem';
  planId: string;
  artifact: Artifact;
};

type UninstallPlanEvent = Envelope & {
  type: 'uninstallPlan';
  plan: {
    id: string;
    groups: Array<{
      id: 'service' | 'data' | 'user' | 'onecli';
      label: string;
      description: string;
      default: 'preserve';
      choices: ['preserve', 'remove'];
    }>;
  };
};
```

The client must send exactly one choice for each group. NanoClaw rejects unsafe
combinations, rescans ownership after approval, and executes only the accepted
plan.

Each result is streamed once:

```ts
type UninstallActionEvent = Envelope & {
  type: 'uninstallAction';
  result: {
    actionId: string;
    artifactId: string;
    outcome: 'removed' | 'preserved' | 'failed' | 'untouched' | 'alreadyAbsent';
    error?: { code: string; message: string };
  };
};
```

Remaining artifacts, including credential backups outside the checkout, are
streamed before the terminal event:

```ts
type UninstallReceiptItemEvent = Envelope & {
  type: 'uninstallReceiptItem';
  section: 'remaining';
  artifact: Artifact;
};

type UninstallCompleteEvent = Envelope & {
  type: 'complete';
  receipt: {
    version: 1;
    outcome: 'success' | 'incomplete';
    checkoutRemoval: { safe: boolean; blockers: string[] };
    completedAt: string;
  };
};
```

There are no pages and no pagination counters. The client may delete the source
checkout only when exit code is `0`, the receipt outcome is `success`, and
`checkoutRemoval.safe` is `true`. NanoClaw never deletes the checkout.

## Minimal client loop

```ts
for await (const event of readNdjson(child.stdout)) {
  switch (event.type) {
    case 'prompt':
      write({ ...envelope, type: 'answer', promptId: event.prompt.id, value: await renderPrompt(event.prompt) });
      break;
    case 'externalAction':
      write({ ...envelope, type: 'externalActionCompleted', actionId: event.action.id, result: await attempt(event.action) });
      break;
    case 'uninstallPlanItem':
      renderArtifact(event.artifact);
      break;
    case 'uninstallPlan':
      write({ ...envelope, type: 'applyUninstall', planId: event.plan.id, choices: await approve(event.plan.groups) });
      break;
    case 'uninstallAction':
    case 'uninstallReceiptItem':
    case 'progress':
    case 'display':
    case 'clearDisplay':
    case 'inputRejected':
      render(event);
      break;
    case 'complete':
    case 'error':
    case 'cancelled':
      return event;
  }
}
```
