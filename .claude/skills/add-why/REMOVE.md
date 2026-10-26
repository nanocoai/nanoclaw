---
name: remove-why
description: Removes the `why` diagnostic added by /add-why.
---

# Remove `why`

Apply copied three files and changed nothing else — no barrel imports, no registry
entries, no dependencies, no Dockerfile or env changes. Removing it is deleting them.

```bash
rm -f scripts/why.ts
rm -f scripts/why-format.test.ts
rm -f src/why-schema.test.ts
```

Confirm nothing is left behind:

```bash
grep -rn "why.ts\|why-schema\|why-format" --include=*.ts --include=*.json . 2>/dev/null | grep -v node_modules
```

That should print nothing. If it matches something, `why` was wired into a caller
after install and that reach-in has to come out by hand — the skill itself never
creates one.

No dependency to uninstall: `why` uses `better-sqlite3`, which the host installs and
verifies on its own (`setup/verify.ts`). Leave it.
