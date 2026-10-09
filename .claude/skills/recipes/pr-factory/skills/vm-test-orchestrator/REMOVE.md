# Remove vm-test-orchestrator

Reverses every change the apply made. After removal, send-to-testing degrades gracefully: approving a test plan answers "no test orchestrator installed" and core skips orchestrator init.

## 1. Tear down live VMs first

Cloned VMs outlive the host process. Before removing, list and remove any `<TEST_VM_NAME_PREFIX>*` VMs on the control plane (defaults shown):

```bash
ssh exe.dev ls            # or your PR_FACTORY_TEST_SSH_HOST
ssh exe.dev rm nctest-<pr-number>   # per leftover VM
```

## 2. Delete the copied files

```bash
rm -f src/modules/pr-factory/test-orchestrator.ts
rm -f src/modules/pr-factory/test-orchestrator.test.ts
```

## 3. Delete the barrel line

In `src/modules/index.ts`, delete the line `import './pr-factory/test-orchestrator.js';`.

## 4. Remove the environment lines

Delete from `.env` if present:

```
PR_FACTORY_TEST_SSH_HOST
PR_FACTORY_TEST_SSH_KEY
PR_FACTORY_TEST_VM_TEMPLATE
TEST_VM_SSH_USER
TEST_VM_NAME_PREFIX
TEST_VM_HOST_TEMPLATE
```

The template VM and provider account are operator infrastructure — keep or retire them per your own policy.

## 5. Restart and validate

> **Skip this step during full-recipe removal.** When tearing down the whole PR Factory, sibling components are still mid-teardown — a build here is expected to be red. Only the recipe-level validation at the end binds. Run the block below only when removing `vm-test-orchestrator` in isolation.

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# systemctl --user restart nanoclaw                # Linux
pnpm run build && pnpm test
```

All green, with the test-orchestrator test gone from the run.
