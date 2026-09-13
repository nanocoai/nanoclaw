# Remove Apple Container Driver

Reverses every change `/add-apple-container` made. Docker becomes the session
driver again on the next service start.

## 1. Deselect the driver

Remove from `.env` (or set back to your previous values):

```
NANOCLAW_RUNTIME_DRIVER=container
CONTAINER_RUNTIME=container
```

With `NANOCLAW_RUNTIME_DRIVER` unset, selection falls back to `docker`.

## 2. Remove the barrel registration

Delete this line from `src/drivers/installed.ts`:

```
import './apple-container-registration.js';
```

## 3. Delete the driver payload

```
rm src/drivers/apple-container-driver.ts
rm src/drivers/apple-container-registration.ts
rm src/drivers/apple-container-driver.test.ts
```

Restore the trunk conformance suite (drops the apple harness):

```
git checkout origin/main -- src/drivers/conformance.test.ts
```

## 4. Rebuild and restart

```
pnpm run build
```

Restart the NanoClaw service. The boot log's `Session runtime driver selected`
line must report `driver="docker"`.

Note: sessions that were running under Apple Container are not adopted by the
docker driver (different runtime, different store). Let them exit or stop them
with `container stop` before switching; agent images must exist in Docker's
store (`./container/build.sh` with `CONTAINER_RUNTIME` unset rebuilds there).
