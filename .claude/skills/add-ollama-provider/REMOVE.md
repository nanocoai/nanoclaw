# Remove Ollama Provider

Puts one agent group back on the Anthropic API. The install itself carries no
Ollama code — this skill only wrote two container-config fields — so there are
no files to delete, no dependency to uninstall, and no rebuild.

## 1. Clear the endpoint and the model

```bash
ncl groups config update --id <GROUP_ID> --base-url "" --model ""
```

`--base-url ""` clears the field back to NULL, which is "call the provider's own
endpoint". `--model ""` clears the model override, which is "use the provider's
default model". To pin a specific Claude model instead, pass it: `--model
claude-sonnet-4-5`.

Confirm both are cleared:

```bash
ncl groups config get --id <GROUP_ID>
```

`base_url` must read `null`, and `model` must read `null` or `""` — both mean
"the provider's default model".

## 2. Restart the group

```bash
ncl groups restart --id <GROUP_ID>
```

Config takes effect at spawn, so the running containers have to go. The next
container gets no `ANTHROPIC_BASE_URL`, no proxy bypass, and calls Anthropic
through the OneCLI gateway again.

## 3. Remove the model note from the standing instructions

If the install added a line to `groups/<folder>/instructions.prepend.md` telling
the agent it runs on a local model, delete that line — it is false now. The
group's composed `CLAUDE.md` picks the change up at its next spawn.

## 4. Optional: uninstall Ollama itself

Nothing in NanoClaw depends on it. If the user wants the disk back:

```bash
ollama list          # what is stored
ollama rm <model>    # per model
```

Then remove the Ollama app or package by whatever means installed it.
