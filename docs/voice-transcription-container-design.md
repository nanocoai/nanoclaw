# Voice Transcription — Container Design

**Status:** Decisions resolved. Implementation ready.
Supersedes PR #1879 (closed per maintainer feedback to keep processing container-side).

## Background

PR #1879 implemented voice transcription on the host (`src/transcription.ts`). Gavriel Cohen's review asked that this work move into the agent container instead: "doing as little as possible in the host side and keep all of the interesting stuff in the agent environment." This document designs the container-side replacement.

---

## Sovereignty Model

**User audio never leaves the user's machine without explicit opt-in.**

This is the defining design choice. The default configuration runs entirely locally — no network call is ever made for transcription unless the user has explicitly enabled it. When a fallback to OpenAI does occur, the source label `[Voice (openai-fallback): "..."]` makes the data path unmistakable in the conversation.

Three env-var knobs govern this:

| Env var | Default | Behavior |
|---|---|---|
| `WHISPER_OPENAI_FALLBACK` | `false` | **Local-only.** If local whisper-cli fails (binary missing, model missing, format unsupported), fail loudly with an actionable error message rather than silently sending audio to OpenAI. |
| `WHISPER_OPENAI_FALLBACK=true` | opt-in | Allows OpenAI Whisper API as fallback. The `(openai-fallback)` source tag in every injected transcript makes the data path unmistakable. |
| `WHISPER_REQUIRE_APPROVAL` | `false` | When `true` and fallback fires, route through NanoClaw's approval primitive (`pickApprover` in `src/modules/approvals/primitive.ts`) — DM the user before each OpenAI call. Audit-heavy users get explicit per-call consent. |

The strict default ("local-only or fail") is the sovereign starting position. Power users opt in deliberately.

---

## Q1: Where does the Whisper binary live?

**Binary in the Dockerfile image; model file mounted from host.**

The container already follows this split for other CLIs (claude-code, agent-browser, vercel — all installed via pinned `pnpm install -g` in the Dockerfile). whisper-cli and ffmpeg follow the same pattern.

Add to the Dockerfile:
```dockerfile
ARG WHISPER_CLI_VERSION=1.7.5
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "whisper-cli@${WHISPER_CLI_VERSION}"

# ffmpeg for audio pre-compression before OpenAI fallback
RUN apt-get install -y --no-install-recommends ffmpeg
```

The model file is **not** baked in — models range from 75 MB (tiny) to 1.5 GB (large-v3), and the right choice is user-specific. The user places the model on the host and mounts it into the container:

```typescript
// In the channel adapter's containerConfig
{
  hostPath: process.env.WHISPER_MODEL_PATH || path.join(HOME_DIR, '.local', 'share', 'whisper', 'model.bin'),
  containerPath: '/whisper/model.bin',
  readonly: true,
}
```

Env var: `WHISPER_MODEL_PATH` — defaults to `~/.local/share/whisper/model.bin`.

If the mount doesn't exist (model not installed), whisper-cli fails and the error propagates loudly (or triggers the optional OpenAI fallback if `WHISPER_OPENAI_FALLBACK=true`).

---

## Q2: How does audio get from the channel adapter into the container?

**Audio files are written to a host directory that is already mounted into the container.**

Signal already does this: attachments land at `~/.local/share/signal-cli/attachments/` on the host, and the container has a read-only bind mount of that directory at `/workspace/attachments/`. The inbound message content includes the path under `/workspace/attachments/<id>`, which the agent-runner can pass directly to the transcription tool.

For other channels (future channels):
- Channel adapters that receive audio write the file to a staging directory on the host (e.g., `~/.local/share/nanoclaw/audio-in/`)
- That directory gets a read-only container mount at `/workspace/audio-in/`
- The inbound message includes the container-relative path

No IPC change required. The mount pattern already used by Signal is the right model.

---

## Q3: Transcription interface — BOTH auto-injection and explicit MCP tool

**Decision: auto-injection is the default UX; explicit MCP tool also exposed.**

### Auto-injection (default)

The agent-runner's message handler auto-transcribes audio attachments before the agent sees them. The transcript is injected inline as part of the message content, labelled with its source:

```
[Voice (local-whisper): "Can you review the PR before end of day?"]
```

or, when fallback fired:

```
[Voice (openai-fallback): "Can you review the PR before end of day?"]
```

The source label is mandatory. It lets the agent disclose to the user when audio was processed remotely, which is a requirement of the sovereignty model.

### Explicit MCP tool

```typescript
mcp__transcription__transcribe(
  filePath: string,
  options?: {
    allowFallback?: boolean;  // override WHISPER_OPENAI_FALLBACK env default
    requireApproval?: boolean; // override WHISPER_REQUIRE_APPROVAL env default
  }
) → {
  text: string;
  source: 'local-whisper' | 'openai-fallback';
  durationMs: number;
  model: string;
}
```

Both paths share the same underlying `transcribeAudio()` function. Auto = MCP tool wired into the inbound handler with default options from env vars.

---

## Q4: OpenAI fallback path and audio pre-compression

**Decision: pre-compress with ffmpeg to 16 kHz mono Opus before any OpenAI call.**

When `WHISPER_OPENAI_FALLBACK=true` and local whisper fails:

1. Run ffmpeg to compress the audio to 16 kHz mono Opus (≈10× smaller than raw, voice-quality-preserving)
2. POST the compressed file to the OpenAI Whisper API

```typescript
// ffmpeg pre-compression
await execa('ffmpeg', [
  '-i', inputPath,
  '-ar', '16000',    // 16 kHz sample rate
  '-ac', '1',        // mono
  '-c:a', 'libopus', // Opus codec
  '-b:a', '16k',     // 16 kbps bitrate — adequate for speech
  outputPath,
]);

// OpenAI call (openai package already in agent-runner deps)
const openai = new OpenAI(); // OPENAI_API_KEY injected by OneCLI vault
const file = await toFile(fs.createReadStream(outputPath), 'audio.opus');
const result = await openai.audio.transcriptions.create({ file, model: 'whisper-1' });
```

The Whisper API has a 25 MB hard limit; even an hour of speech compresses to a few MB at 16 kbps Opus. This eliminates the OneCLI body-size concern entirely.

**OneCLI and multipart/form-data:** The OneCLI credential proxy operates at the HTTP layer — it intercepts TLS, injects `Authorization`, and forwards the request body unmodified. `multipart/form-data` is opaque bytes from the proxy's perspective. Not a blocker.

**`WHISPER_REQUIRE_APPROVAL=true` flow:** before the ffmpeg + OpenAI call, call `pickApprover` to identify the right approver for this agent group, send a DM approval request via the existing approval primitive, and wait for confirmation before proceeding.

---

## Implementation Plan

1. **Dockerfile**: add `WHISPER_CLI_VERSION` ARG + `pnpm install -g whisper-cli@...`; add `apt-get install -y ffmpeg`
2. **`container/agent-runner/src/transcription/transcribe.ts`**: core `transcribeAudio()` — local whisper first, optional OpenAI fallback with ffmpeg pre-compression; reads `WHISPER_OPENAI_FALLBACK` and `WHISPER_REQUIRE_APPROVAL` env vars
3. **`container/agent-runner/src/mcp-tools/transcription.ts`**: MCP tool wrapping `transcribeAudio()` with option overrides
4. **`container/agent-runner/src/formatter.ts`** (or message handler): auto-transcribe audio attachments before injecting into agent context; add `[Voice (source): "..."]` label
5. **`container.json`** scaffold (via `group-init.ts`): document `WHISPER_MODEL_PATH`, `WHISPER_OPENAI_FALLBACK`, `WHISPER_REQUIRE_APPROVAL` as recognized env vars
6. **Remove host-side transcription**: delete `src/transcription.ts`; remove transcription call from `src/channels/signal.ts`
7. **Tests**: mock whisper-cli exec and OpenAI client in container test suite; test sovereignty defaults (fallback disabled by default, error on failure)

---

## Out of Scope (v1)

- **Chunked long-form audio**: files exceeding the post-compression OpenAI limit (multi-hour recordings). Flag for future work.
- **Per-user transcription preference UI**: opt-in/opt-out per conversation or per sender. Env vars are the configuration surface for v1.
- **Model auto-download**: automatic fetch of ggml model files. User places the file manually; missing model = loud error.
- **Non-whisper local engines**: only whisper-cli is supported in v1. Other local ASR options are out of scope.
