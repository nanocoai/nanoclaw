---
name: vm-test-orchestrator
description: PR Factory component — the VM control plane for test runs. Registers a TestOrchestratorModule on pr-factory-core's test-orchestration seam; approved test plans clone an ephemeral VM from a template over SSH, check out the PR, build, start the service, and hand the ready VM to the tester agent. exe.dev conventions are the documented defaults; the SSH user, VM naming, and host template are env knobs.
---

# vm-test-orchestrator (PR Factory component)

The test-VM half of the PR Factory's send-to-testing flow. `pr-factory-core` owns the coordination side (approval card, tester-agent wake, verdict handling, 30-minute timeout) and a seam (`src/modules/pr-factory/test-orchestration.ts`); without this component, approved test plans answer "no test orchestrator installed". With it:

1. A human approves a test plan → core calls `submitTest()` on the registered module.
2. The sequential queue clones an ephemeral VM from the template (`cp <template> <name>` + `tag <name> ephemeral` on the control-plane host), waits for SSH, checks out the PR (`git fetch origin pull/<n>/head`), builds (`pnpm run build`), restarts the service, and polls systemd until stable.
3. On success core's `onVmReady` wakes the tester agent with the plan + VM host; on failure `onRunFailed` posts the reason and a retry card.
4. VMs stay alive after a run for investigation (pool capped at 20, oldest evicted); they are destroyed on PR close/merge, run timeout, and shutdown.

Skill-owned file: `src/modules/pr-factory/test-orchestrator.ts`. Integration surface: one appended barrel line in `src/modules/index.ts`. No new dependencies — `ssh` is a host binary prerequisite.

## Prerequisites

Probe each before applying; stop on a failed probe and do what it names first.

1. **The `pr-factory-core` component is applied** (this component implements its seam contract):

   ```bash
   grep -q 'export function registerTestOrchestrator' src/modules/pr-factory/test-orchestration.ts && echo OK
   ```

   If it fails: apply the `pr-factory-core` component first.

2. **An OpenSSH client on the host** (all VM control runs over `execFile('ssh', ...)`):

   ```bash
   command -v ssh && echo OK
   ```

3. **A VM provider account + template VM** (see "Template VM contract" below) and the **tester agent group** (`pr-tester`, created per `pr-factory-core`'s SKILL.md — without it core never initializes the orchestrator).

Each step below is idempotent: if the file or line is already present, leave it as is and continue.

## Apply

All copy sources are under this component's folder; run every command from the repo root:

```bash
SKILL=.claude/skills/recipes/pr-factory/skills/vm-test-orchestrator
```

### 1. Copy the module

```bash
cp $SKILL/files/src/modules/pr-factory/test-orchestrator.ts src/modules/pr-factory/test-orchestrator.ts
```

### 2. Append the modules-barrel line (`src/modules/index.ts`)

After the `import './pr-factory/index.js';` line, append (skip if already present):

```typescript
import './pr-factory/test-orchestrator.js';
```

### 3. Copy the guard test

```bash
cp $SKILL/files/src/modules/pr-factory/test-orchestrator.test.ts src/modules/pr-factory/test-orchestrator.test.ts
```

| Test | Guards |
|------|--------|
| `src/modules/pr-factory/test-orchestrator.test.ts` | The barrel line via the REAL modules barrel (`getTestOrchestrator()` non-null) and the full lifecycle through the real queue against a PATH-shimmed `ssh`: clone/tag on the control plane, per-VM login as `<TEST_VM_SSH_USER>@<templated host>`, PR checkout/build/stability probe, `destroyVm` teardown + idempotence, the failure path's `onRunFailed` + cleanup (with core pr_threads/session context reads on a real migrated DB), shutdown dropping the callbacks — in one generation with every knob overridden (nothing exe.dev-shaped hard-coded) and one pinning the documented defaults (`exedev@nctest-<pr>.exe.xyz` via `exe.dev`) |

## Configuration

### Environment (`.env`)

```bash
PR_FACTORY_TEST_VM_TEMPLATE=<template VM name>   # required — tests cannot run without it
PR_FACTORY_TEST_SSH_HOST=exe.dev                 # control-plane host (default shown)
PR_FACTORY_TEST_SSH_KEY=                         # ssh identity for the control plane; omit to use ssh defaults
TEST_VM_SSH_USER=exedev                          # login user on the per-test VMs (default shown)
TEST_VM_NAME_PREFIX=nctest-                      # VM name = <prefix><pr-number> (default shown)
TEST_VM_HOST_TEMPLATE={name}.exe.xyz             # per-VM hostname; {name} expands to the VM name (default shown)
```

The defaults are exe.dev's conventions; any provider whose control plane speaks `cp <template> <name>` / `tag <name> ephemeral` / `rm <name>` over SSH and gives each VM a DNS-resolvable hostname works by overriding the knobs.

If `NANOCLAW_EGRESS_LOCKDOWN` is enabled (default off), the tester agent's container cannot SSH to the VMs — leave it off or allowlist the VM hosts.

### Template VM contract

Prepared once by the operator; the module assumes:

- the project checked out at `~/nanoclaw` with an `origin` remote that serves `pull/<n>/head` refs,
- buildable with `pnpm run build`,
- running as a **systemd user service** whose unit name contains `nanoclaw` (the stability probe greps `systemctl --user list-unit-files` for it),
- the host's control-plane SSH key authorized for both the control plane and `TEST_VM_SSH_USER` on cloned VMs.

### Provisioning SSH access for the tester → VM path (required)

There are **two SSH legs**, and both need keys in place before a test run can succeed:

1. **Host → control plane / cloned VMs.** The NanoClaw host runs `ssh <control-plane> cp/tag/rm …` to clone and reap VMs. Point `PR_FACTORY_TEST_SSH_KEY` at the host identity authorized on the control-plane host (or rely on ssh's default identities); that same public key must be in `authorized_keys` for `TEST_VM_SSH_USER` on the cloned VMs (the template bakes it in, so every clone inherits it).
2. **Tester container → cloned VM.** Once a VM is ready, the *tester agent runs inside its container* and SSHes to `<TEST_VM_HOST_TEMPLATE>` as `TEST_VM_SSH_USER` to execute the plan. The tester container therefore needs its own private key and the matching public key in the VM's `authorized_keys`. Mount or inject that key into the `pr-tester` group's container (e.g. a mounted `~/.ssh` dir on the host allowlist, or a key provisioned into the group's workspace) and add a `known_hosts` entry or `StrictHostKeyChecking accept-new` so the first connection isn't blocked on a prompt. Without this leg the VM clones and reports ready, but the tester cannot log in and the run times out.

Keep both keys read-restricted and scoped to the test VMs — they are infrastructure credentials, not GitHub or vault secrets.

## Validate

```bash
pnpm run build
pnpm test
```

All green. Any failure means a step didn't apply cleanly. For an end-to-end smoke test (real VM clone), approve a test plan on a live PR thread and watch `logs/nanoclaw.log` for `Test VM ready`.
