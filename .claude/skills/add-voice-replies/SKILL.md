---
name: add-voice-replies
description: Give selected NanoClaw agent groups spoken replies. Adds a text-to-speech MCP tool with pluggable providers (offline espeak-ng by default, any OpenAI-compatible speech endpoint including local servers, or ElevenLabs), configured per group, and delivered as an audio file through the existing send_file tool. Use when the user wants agents to answer with voice or audio messages.
---

# Add Voice Replies

This skill adds a small stdio MCP server, `voice`, to the agent-runner tree.
It exposes one tool, `mcp__voice__synthesize_speech({ text, voice? })`, which
turns text into an audio file and returns its path. The agent delivers the
file with the core `mcp__nanoclaw__send_file` tool, so any channel that
accepts file attachments can carry a spoken reply.

Providers are a registry in `container/agent-runner/src/tts/index.ts`:

| Provider | Needs | Output |
|----------|-------|--------|
| `espeak` (default) | the `espeak-ng` apt package in the group's image. Offline, no credential | WAV |
| `openai` | any server implementing `POST <base>/audio/speech` in the OpenAI shape. A local speech server needs no credential; the hosted OpenAI API needs a gateway credential | server's choice (`TTS_FORMAT`) |
| `elevenlabs` | an ElevenLabs API key stored in the credential gateway | MP3 by default (`TTS_FORMAT`) |

Every setting is per group, carried in the MCP server's `env` when it is
registered. No key ever goes in that env: hosted providers get their key from
the install's credential gateway, which injects it per request.

The skill covers outbound speech only. Transcribing inbound voice notes and
captioning images are separate capabilities.

## Phase 1: Pre-flight

Check whether the code is already installed:

```bash
test -f container/agent-runner/src/tts/server.ts && echo INSTALLED || echo NOT_INSTALLED
```

If `INSTALLED`, skip to Phase 3.

List the agent groups and ask the user which ones should get voice replies,
and which provider each should use. Recommend `espeak` unless the user already
runs a local speech server or wants a hosted voice.

```bash
ncl groups list
```

## Phase 2: Copy the code

The agent-runner source is mounted read-only into every container at
`/app/src`, so copied files are live on the next container start without an
image rebuild.

```bash
mkdir -p container/agent-runner/src/tts
cp .claude/skills/add-voice-replies/tts/*.ts container/agent-runner/src/tts/
```

Validate:

```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
(cd container/agent-runner && bun test src/tts)
```

- `tts-registration.test.ts` imports only the barrel and fails when a provider
  is no longer registered.
- `voice-server.test.ts` spawns the real server over stdio, the way the agent
  provider does, lists its tools, calls `synthesize_speech` against a fake
  speech endpoint, and checks the written file and the request sent.

## Phase 3: Configure each group

`ncl groups config add-package`, `config add-mcp-server`, and `groups restart`
are approval-gated. From inside a container they return `approval-pending`;
wait for the approval before the next step.

### Settings

| Env key | Meaning | Default |
|---------|---------|---------|
| `TTS_PROVIDER` | `espeak`, `openai`, or `elevenlabs` | `espeak` |
| `TTS_VOICE` | espeak voice or language code (`en`, `en-us`, `de`); OpenAI-shape voice name; ElevenLabs voice id | `en` / `alloy` / a stock ElevenLabs voice |
| `TTS_MODEL` | OpenAI-shape model name; ElevenLabs `model_id` | `tts-1` / `eleven_multilingual_v2` |
| `TTS_BASE_URL` | speech endpoint base | `https://api.openai.com/v1` / `https://api.elevenlabs.io` |
| `TTS_LANGUAGE` | espeak voice when `TTS_VOICE` is unset; ElevenLabs `language_code` | unset |
| `TTS_FORMAT` | OpenAI-shape `response_format` (`mp3`, `opus`, `wav`, ...); ElevenLabs `output_format` (`mp3_44100_128`, ...) | provider default |
| `TTS_OUTPUT_DIR` | where audio files are written inside the container | `/tmp/voice-replies` |

The agent may pass `voice` on a call to override `TTS_VOICE` for that reply,
for example to pick an espeak language that matches the reply.

### Option A: espeak (offline)

Add the package to the group's image:

```bash
ncl groups config add-package --id <group-id> --apt espeak-ng
```

Use this env when registering:

```json
{"TTS_PROVIDER":"espeak","TTS_VOICE":"en"}
```

Restart with `--rebuild` in the final step so the package is installed.

### Option B: a local OpenAI-compatible speech server

Point the provider at a speech server running on the host. Use the host
alias your container runtime provides (the same one other local-model tools
use), shown here as `<host-alias>`:

```json
{"TTS_PROVIDER":"openai","TTS_BASE_URL":"http://<host-alias>:<port>/v1","TTS_MODEL":"<model>","TTS_VOICE":"<voice>"}
```

Check the endpoint from the host first:

```bash
curl -s -o /tmp/voice-check.mp3 -w '%{http_code}\n' \
  -H 'content-type: application/json' \
  -d '{"model":"<model>","voice":"<voice>","input":"hello"}' \
  http://127.0.0.1:<port>/v1/audio/speech
```

If the selected gateway restricts egress, allow that host and port there.

### Option C: a hosted provider (OpenAI or ElevenLabs)

The key lives in the credential gateway, scoped to the provider's API host.
Ask the gateway for its connection step for that host:

```bash
ncl groups connect --id <group-id> --host api.elevenlabs.io   # or api.openai.com
```

Follow the returned step to store the key with this injection:

| Host | Header | Value format |
|------|--------|--------------|
| `api.elevenlabs.io` | `xi-api-key` | `{value}` |
| `api.openai.com` | `Authorization` | `Bearer {value}` |

The installed gateway's own skill documents how it stores a credential if the
connection step points to an operator console.

Env for ElevenLabs:

```json
{"TTS_PROVIDER":"elevenlabs","TTS_VOICE":"<voice-id>"}
```

Env for the hosted OpenAI API:

```json
{"TTS_PROVIDER":"openai","TTS_VOICE":"alloy"}
```

### Register the server and restart

For each selected group, register the server with the env chosen above:

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name voice \
  --command bun \
  --args '["run","/app/src/tts/server.ts"]' \
  --env '<env-json>'
```

Then restart. Add `--rebuild` when an apt package was added:

```bash
ncl groups restart --id <group-id> --rebuild \
  --message "Voice replies are installed. Reply to this message with a short spoken greeting."
```

To change settings later, run the same `add-mcp-server` command with a new
env (it replaces the `voice` entry) and restart the group.

The per-group registration is runtime state stored through `ncl`, so it has
no line in the tree for a test to guard. The in-tree integration is the copied
code and its tests from Phase 2.

## Phase 4: Verify

Confirm the stored entry:

```bash
ncl groups config get --id <group-id>
```

The restart message asks the agent for a spoken greeting. It should call
`mcp__voice__synthesize_speech`, then `mcp__nanoclaw__send_file` with the
returned path, and an audio attachment should arrive in the chat.

## Optional: other voices and languages

- espeak-ng ships voices for many languages; list them with
  `espeak-ng --voices` inside the container.
- For more natural offline voices, run any local server that implements the
  OpenAI speech endpoint and use Option B. Model licenses vary per language,
  and some are non-commercial. Check the license before deploying one.

## Troubleshooting

- **`espeak-ng failed to start`**: the package is missing from the image. Run
  `ncl groups config add-package --id <group-id> --apt espeak-ng`, then
  `ncl groups restart --id <group-id> --rebuild`.
- **`Unknown TTS provider`**: `TTS_PROVIDER` does not match a registered name.
  The error lists the registered ones.
- **`401` or `403` from a hosted provider**: the gateway has no credential for
  that host, or the header scheme is wrong. Re-run the connection step in
  Option C and check the injection table.
- **Connection refused on a local server**: check the `curl` in Option B from
  the host, confirm `TTS_BASE_URL` uses the container host alias, and check any
  gateway egress rule.
- **The agent answers in text only**: confirm `ncl groups config get` shows the
  `voice` server and the group was restarted. Ask explicitly for a voice reply.
- **The audio arrives as a file, not a voice bubble**: delivery uses the
  channel's normal file attachment path. Some channels render OGG/Opus as a
  voice note; set `TTS_FORMAT` to `opus` on an OpenAI-shape server to get it.

## Removal

See [REMOVE.md](REMOVE.md).
