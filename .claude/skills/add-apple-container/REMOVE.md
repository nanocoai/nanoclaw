# Remove Apple container driver

Reverses every change `/add-apple-container` makes. Docker becomes the session driver
again on the next service start.

## 1. Stop Apple container sessions

The Docker driver does not adopt sessions running under Apple container. Stop the
NanoClaw service, then stop this install's session containers:

```bash
container list --all
container stop <id> ...
```

## 2. Deselect the driver

Delete the `NANOCLAW_RUNTIME_DRIVER=container` line from `.env`. With it unset,
selection falls back to `docker`.

Tell the user to delete `export CONTAINER_RUNTIME=container` from their shell profile
and open a new terminal.

## 3. Remove the registration line

Delete this line from `src/drivers/installed.ts`:

```
import './apple-container-registration.js';
```

## 4. Delete the driver files

```bash
rm -f src/drivers/apple-container-driver.ts \
  src/drivers/apple-container-registration.ts \
  src/drivers/apple-container-registration.test.ts \
  src/drivers/apple-container-driver.test.ts \
  src/drivers/apple-nested-mounts.test.ts \
  src/drivers/apple-container-cli-contract.test.ts
```

## 5. Rebuild and restart

```bash
pnpm run build
pnpm exec vitest run src/drivers/
./container/build.sh
```

Run `./container/build.sh` in a new terminal, so the agent image is built into Docker.
Restart the NanoClaw service. The boot log's `Session runtime driver selected` line must
report `driver="docker"`.

Images left in Apple container's store are not removed. Delete them with
`container image list` and `container image delete <ref>` if you no longer need them.
