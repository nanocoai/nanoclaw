# Remove Flows

Every step is safe to run even if some steps were never applied.

## 1. Detach tasks that run a flow

List the tasks and look for a script that runs a `.flow.ts` file:

```bash
ncl tasks list
```

For each one, either point `--script` at a replacement or clear it:

```bash
ncl tasks update <task-id> --group <agent-group-id> --script none
```

A task left pointing at a flow fails on every run once the base class is gone.

## 2. Delete the copied files

```bash
rm -f container/agent-runner/src/flows/flow.ts \
      container/agent-runner/src/flows/example.flow.ts \
      container/agent-runner/src/flows/flow.test.ts
rmdir container/agent-runner/src/flows 2>/dev/null || true
```

## 3. Delete group flow files (optional)

Flow files written under `groups/<folder>/flows/` import the base class and
stop working without it. Delete them, or keep them as a record:

```bash
ls groups/*/flows/*.flow.ts 2>/dev/null
```

## 4. Verify

```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

The agent-runner source is mounted live, so the next container spawn runs
without the flows directory; no image rebuild or service restart is needed.
