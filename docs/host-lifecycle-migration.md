# Host lifecycle migration

NanoClaw now has one host lifecycle registry. The legacy shutdown hooks in
`src/response-registry.ts` have been removed, and all host modules register
startup and shutdown work through `src/host-lifecycle.ts`.

## Detect affected custom modules

Search custom NanoClaw source for the removed exports:

```bash
rg -n "onShutdown|getShutdownCallbacks" src
```

No result means the custom source does not use the removed interface. A match
in an import from `response-registry.ts` requires migration.

## Why the interface changed

Keeping shutdown callbacks in both the response registry and the lifecycle
registry created two ordering rules and two cleanup paths. One registry makes
startup and shutdown ordering explicit: startup callbacks run FIFO, while
shutdown callbacks run LIFO so later-started modules clean up first.

## Update custom modules

Replace `onShutdown()` with `onHostShutdown()` and keep the callback body
unchanged:

```ts
// Before
import { onShutdown } from './response-registry.js';

onShutdown(() => {
  stopCustomModule();
});

// After
import { onHostShutdown } from './host-lifecycle.js';

onHostShutdown(() => {
  stopCustomModule();
});
```

Adjust the relative import path to the custom module's location.

Code that inspected `getShutdownCallbacks()` in a registration test should use
`getHostShutdownCallbacks()` instead. Host orchestration should call
`stopHostModules()` rather than execute registered callbacks directly.

## Verify the migration

Confirm that no removed calls remain, then build and test NanoClaw:

```bash
rg -n "onShutdown|getShutdownCallbacks" src
pnpm run build
pnpm test
```

The first command should return no matches. During a graceful shutdown, each
registered cleanup should run once in reverse registration order.

## Roll back

This change does not migrate stored data. To roll back, return NanoClaw to the
previous revision and restore the custom module's `response-registry.ts`
import. Rebuild and restart NanoClaw using the same procedure used for the
update, then verify a graceful shutdown again.
