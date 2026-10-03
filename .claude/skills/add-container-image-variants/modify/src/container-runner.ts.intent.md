# Intent: src/container-runner.ts modifications

## What changed
In `buildContainerArgs`, the image pushed as the final argument to the container
run command now uses the group's `containerConfig.image` when set, falling back
to the global `CONTAINER_IMAGE` constant.

## Key sections

### buildContainerArgs (near the end of the function)
- Changed: `args.push(CONTAINER_IMAGE)`
- To: `args.push(group.containerConfig?.image || CONTAINER_IMAGE)`

The `group` parameter is already available in scope — `buildContainerArgs` receives
it via the `RegisteredGroup` argument passed from `runContainerAgent`.

## Invariants (must-keep)
- All mount construction logic (`buildVolumeMounts`) unchanged
- All container args (user, timezone, volume flags) unchanged
- Timeout logic, IPC, streaming output — all unchanged
- `CONTAINER_IMAGE` import from `./config.js` unchanged (still used as default)
