# Add Voice Transcription (Local Whisper)

Enables local audio/voice message transcription for any NanoClaw channel that
delivers voice attachments (Signal, Telegram, WhatsApp, etc.). No cloud API —
transcription runs entirely on-device using either OpenAI Whisper (Python) or
whisper.cpp.

## Pre-flight

Check whether transcription is already working:

```bash
ffmpeg -version >/dev/null 2>&1 && echo "ffmpeg OK" || echo "ffmpeg MISSING"
{ ${WHISPER_BIN:-whisper-cli} --version 2>/dev/null || ${WHISPER_BIN:-whisper} --help 2>/dev/null; } \
  && echo "whisper OK" || echo "whisper MISSING"
ls data/models/ggml-*.bin 2>/dev/null || echo "no model found"
```

The second check tries `whisper-cli` first (whisper.cpp), then `whisper` (openai-whisper). If `WHISPER_BIN` is set it uses that directly.

If ffmpeg and whisper are both OK, transcription is already set up. Skip to Environment Variables.
(No model file is needed for openai-whisper — it manages its own cache under `~/.cache/whisper/`.)

---

## Backend A: openai-whisper (Python, easier install)

Best for quick setup or when you can't build from source.

### 1. Install ffmpeg

**macOS:**
```bash
brew install ffmpeg
```

**Debian/Ubuntu:**
```bash
sudo apt-get install -y ffmpeg
```

**RHEL / Rocky / AlmaLinux 9:**
The package manager dependency chain (`rubberband → ladspa`) is broken on
RHEL 9-family — `dnf install ffmpeg` will fail. Use a static binary instead:

```bash
ARCH=$(uname -m)   # x86_64 or aarch64
curl -fsSL "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${ARCH}-static.tar.xz" \
  | tar -xJ --strip-components=1 -C ~/.local/bin --wildcards '*/ffmpeg'
chmod +x ~/.local/bin/ffmpeg
# Make sure ~/.local/bin is in PATH (add to ~/.bashrc if needed):
export PATH="$HOME/.local/bin:$PATH"
ffmpeg -version
```

### 2. Install openai-whisper

```bash
uv tool install openai-whisper
```

> `uv` is preferred over `pip`. Install uv if needed: `curl -LsSf https://astral.sh/uv/install.sh | sh`

### 3. Configure

Add to `.env`:

```bash
WHISPER_BIN=whisper
# WHISPER_MODEL=base   # optional — tiny/base/small/medium/large (default: base)
```

`WHISPER_MODEL` is treated as a model name (not a path) when `WHISPER_BIN=whisper`.
The model is downloaded on first use to `~/.cache/whisper/` — first transcription
will be slow while it downloads (~140 MB for base).

---

## Backend B: whisper.cpp (faster, no Python)

Best for production or lower-latency transcription. Requires a C++ build chain.

### 1. Install ffmpeg

Same as Backend A above.

### 2. Build whisper.cpp

```bash
# Requires: git, cmake, make, gcc/g++
git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp
cmake -B build && cmake --build build --config Release -j$(nproc)
sudo cp build/bin/whisper-cli /usr/local/bin/whisper-cli
```

**macOS shortcut:**
```bash
brew install whisper-cpp ffmpeg
```

### 3. Download a model

```bash
mkdir -p data/models
curl -L -o data/models/ggml-base.bin \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
```

| Model | Size | Notes |
|-------|------|-------|
| `ggml-tiny.bin` | 75 MB | Fastest, lowest accuracy |
| `ggml-base.bin` | 142 MB | Good balance (default) |
| `ggml-small.bin` | 466 MB | Better accuracy |
| `ggml-medium.bin` | 1.5 GB | High accuracy, slow |

### 4. Configure

Add to `.env`:

```bash
WHISPER_BIN=whisper-cli
WHISPER_MODEL=data/models/ggml-base.bin
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_BIN` | `whisper-cli` | Path or name of whisper binary |
| `WHISPER_MODEL` | `data/models/ggml-base.bin` | Model path (whisper.cpp) or name (openai-whisper) |

NanoClaw auto-detects which backend is in use: if `basename(WHISPER_BIN) === 'whisper'`
it uses the openai-whisper output-file mode; otherwise it uses the whisper.cpp
stdout mode.

---

## Restart the service

```bash
# Linux
systemctl --user restart nanoclaw

# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

---

## Verify

Send a voice message to the bot and check the logs:

```bash
tail -f logs/nanoclaw.log | grep -E 'transcri|whisper|ffmpeg|audio'
```

You should see a `Transcribed audio` log line with a non-zero `chars` value.
If transcription fails it degrades gracefully — voice messages are still
delivered as attachments; only the transcript is absent.

---

## Troubleshooting

**`spawn ffmpeg ENOENT` / `ffmpeg: command not found`** — ffmpeg not in PATH.
Install it (see above). On RHEL/Rocky 9, use the static binary from
johnvansickle.com; package manager installs fail on this distro family.

**First transcription very slow or timed out (openai-whisper)** — the model is
being downloaded to `~/.cache/whisper/` on first use. Subsequent runs are fast.
Wait ~5 minutes or pre-download: `python3 -m whisper.assets --model base` (or
just retry — the timeout is 3 minutes and the download usually beats it).

**`No module named whisper` / `whisper: command not found`** — openai-whisper
not installed or not in PATH. Run `uv tool install openai-whisper`. Confirm with
`which whisper`.

**`whisper-cli: command not found`** — whisper.cpp binary not in PATH.
Either run `sudo cp build/bin/whisper-cli /usr/local/bin/whisper-cli` after
building, or set `WHISPER_BIN` to the full path.

**`Model file not found`** — download a GGML model (see Backend B, step 3).
Or switch to openai-whisper which downloads its own model automatically.

**Transcript returned but wrong language** — set `WHISPER_MODEL` to a larger
model for better accuracy, or set the language explicitly (see whisper docs).

**Voice messages delivered as attachments only, no transcript** — transcription
is failing silently. Current `src/transcription.ts` logs failures at
`log.debug`, which does **not** appear in `logs/nanoclaw.log` or
`logs/nanoclaw.error.log` at default log level — a broken whisper install can
go unnoticed indefinitely with zero trace in the logs. Verify manually instead:
run the exact ffmpeg + whisper commands from "How it works" by hand against a
copy of one of the failing attachments (under `data/attachments/` or your
channel's attachment dir) and see where it actually breaks.

**Works in your shell but not from the running service (Linux)** — `uv tool
install` puts binaries in `~/.local/bin`, and `which whisper` succeeding in
your interactive shell does not prove the systemd `--user` service can find
it. Unit files commonly set an explicit, narrower `Environment=PATH=...` that
silently omits `~/.local/bin` (or `/usr/local/bin`, if ffmpeg was installed as
a static binary there). Check what the service actually has:
```bash
systemctl --user cat nanoclaw | grep 'Environment=PATH'
```
If the directory holding your `whisper`/`ffmpeg` binary isn't listed, add it
to that line, then `systemctl --user daemon-reload && systemctl --user
restart nanoclaw`. This exact mismatch is why an early version of this setup
failed with `spawn ffmpeg ENOENT` under the service despite ffmpeg being
installed and working from the terminal.

**Whisper ran, produced a transcript file, but it's empty — for a real voice
note with actual speech** — not necessarily a pipeline bug. openai-whisper's
language auto-detection can misfire on short or quiet clips (e.g. detects
Korean for a two-second Hebrew/English blip) and return nothing; NanoClaw
treats an empty string identically to "no speech detected" — transcript is
null, attachment delivered with no text, and the agent has no way to tell the
difference from silence. If this happens often, pin the language explicitly
(edit the `whisper` invocation in `transcribeOpenAIWhisper()` to add
`--language en` or similar) or move to a larger `WHISPER_MODEL`.

---

## How it works

**Transcription happens entirely in the host process — never inside the
agent's container.** The agent has no whisper or ffmpeg of its own, and
doesn't need any. If the agent ever tells a user it "can't transcribe voice
messages (no speech-to-text tool installed)," that's the agent reasoning
about its own sandbox — which has no STT and never will — not a statement
about whether this skill's pipeline is working. It has no visibility into
this step at all; from its point of view a voice note either already arrived
as text, or it's just an audio attachment with nothing else to go on.

The governing loop, one message at a time (e.g. Signal):

1. The channel adapter (`src/channels/signal.ts`, running on the host)
   receives the inbound message and detects a voice/audio attachment,
   downloading it to disk.
2. Still on the host, still before the message reaches the router, the
   adapter calls `transcribeAudio(path)` in `src/transcription.ts`.
3. `transcribeAudio` shells out to `ffmpeg` to downsample the attachment to
   16 kHz mono WAV, then to the configured whisper backend:
   - **whisper.cpp**: calls `whisper-cli -m MODEL -f file.wav -nt`, reads stdout
   - **openai-whisper**: calls `whisper file.wav --model NAME --output_format
     txt --output_dir TMPDIR --fp16 False`, reads the `.txt` output file
4. If a transcript comes back, the adapter rewrites the message content to
   `[Voice: <transcript>]` — that's the string the router writes into the
   session's `inbound.db`, and the only thing the agent ever sees. The raw
   audio is still delivered as an attachment; only the text is synthesized
   on top of it.
5. If transcription returns null (no backend configured, ffmpeg/whisper
   error, or genuinely no speech detected), the message is routed with no
   transcript at all — attachment-only, identical to never having installed
   this skill. The agent then has nothing but a bare attachment to react to.

**Practical consequence:** `WHISPER_BIN` / `WHISPER_MODEL` and the whisper
binary itself are host concerns. Applying a fix means restarting the **host**
service (`systemctl --user restart nanoclaw` / `launchctl kickstart ...`),
not `ncl groups restart` — the agent's container never runs whisper or reads
those env vars, so restarting it changes nothing here.
