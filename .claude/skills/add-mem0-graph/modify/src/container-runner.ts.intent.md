# Intent: src/container-runner.ts

## What changed
Added memory/ subdirectory creation in the per-group IPC namespace so containers can write memory operations.

## Key sections
- **buildVolumeMounts()**: Added fs.promises.mkdir for memory/ subdirectory alongside existing messages/ and tasks/

## Invariants
- All existing volume mounts unchanged
- buildContainerArgs unchanged
- runContainerAgent unchanged
- writeTasksSnapshot unchanged
- writeGroupsSnapshot unchanged
- All existing IPC directories still created

## Must-keep
- All existing volume mount logic
- Secret handling via stdin
- Container timeout and streaming logic
- Session media cleanup
