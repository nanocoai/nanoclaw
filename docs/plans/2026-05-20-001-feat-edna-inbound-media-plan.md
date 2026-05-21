---
title: "feat: Edna inbound media — materialize image/video attachments for Veo"
type: feat
status: active
created: 2026-05-20
---

# feat: Edna inbound media — materialize image/video attachments for Veo

## Summary

Close the inbound-media gap so Edna can actually pass user-uploaded images and videos into Veo (Gemini) video generation, not just describe them. Today inbound images reach the model as inline base64 content blocks but never touch the workspace filesystem, and inbound videos are dropped at the Slack handler. This plan: (1) accepts `video/mp4` and `video/quicktime` MIMEs on Slack inbound; (2) writes every accepted attachment to a per-group `inbox/` directory inside the agent's workspace (bind-mounted as `/workspace/group/inbox/`); (3) injects a short text marker into the user message listing the relative paths so Edna sees the files in her prompt and can hand them to `generate_video.py -i` or `extract_frame.py --input`. Slack-first, mirroring the outbound video plan's scope.

---

## Problem Frame

The outbound side just shipped on this branch: Veo scripts, IPC `videos/` namespace, MCP `send_video`, Slack `sendVideo` via `files.uploadV2`. The inbound side is the only thing standing between Edna and a fully usable Veo flow:

1. **Slack drops non-image MIMEs silently-ish.** `src/channels/slack.ts:161-173` filters `msg.files[]` through `isSupportedImageMime`, and `src/image.ts:11-19` only accepts `image/*`. A user uploading an `.mp4` gets a warn log on the orchestrator and silence from Edna.
2. **Images flow as base64 only.** `src/image.ts:33-64` re-encodes to JPEG and emits `ImageAttachment { mediaType, data: base64 }`. The bytes reach the SDK as a Claude `image` content block (`container/agent-runner/src/message-stream.ts:34-55`) and are never written to disk.
3. **Veo scripts require on-disk paths.** `container/skills/veo/scripts/generate_video.py:184,187` and `container/skills/veo/scripts/extract_frame.py:73` both validate `Path(p).is_file()`. There is no Veo code path that accepts inline base64.

Result today: a user sending Edna a JPEG with "animate this" gets a model that can describe the picture but cannot reference it from Veo. A user sending an `.mp4` with "extend this" gets nothing at all — the attachment vanishes before Edna's prompt is built.

Two constraints shape the fix:

1. **Inline base64 still has to flow for images.** The model needs to see the image visually in the conversation; we're not replacing that path. The on-disk file is *additive*.
2. **Edna needs to know the file path.** Veo's input is a string path passed to argparse; the model has to put that string in its command. A structured field in `NewMessage` isn't visible to the model — only the prompt text is. So the path has to appear in the message text Edna receives.

The existing branch already established the path-validation pattern that any new write into `groups/{folder}/` must follow: defense-in-depth via `abs !== root && !abs.startsWith(root + path.sep)` (`src/ipc.ts:594,659`).

---

## Inferred Bets

Solo invocation — these are the implementer's calls based on Phase 1 research; flagged so the user can override before code lands.

- **Materialize attachments at the Slack handler**, not at the orchestrator or container. The Slack handler is the only layer with all three needed inputs (bytes, MIME, group folder) and is where the current image fetch already lives — keep responsibility close to the source.
- **Write under `groups/{folder}/inbox/`.** New, conflict-free subdirectory inside the existing per-group mount (`src/container-runner.ts:104-116`, read-write bind mount). Becomes `/workspace/group/inbox/` inside the container with zero new mount plumbing. `conversations/` is the existing orchestrator-owned subdirectory precedent.
- **Inject a text marker, don't propagate a structured field through the container pipeline.** The model consumes text; a `videos?: VideoAttachment[]` on `NewMessage` is useful at the channel boundary (tests, future channel parity) but doesn't need to ride through `ContainerInput` or `group-queue.ts` IPC payloads. The path arrives in the prompt text, not as a typed field. Image base64 still rides the existing structured path because it has a real consumer (the SDK content block).
- **Filename = `{ISO_compact_ts}-{slack_file_id}.{ext}`**, extension derived from MIME (`image/jpeg → .jpg`, `image/png → .png`, `image/heic → .jpg` because we re-encode, `video/mp4 → .mp4`, `video/quicktime → .mov`). User-supplied `file.name` is ignored entirely — Slack file IDs are unique per workspace and the MIME-derived extension closes the path-injection vector.
- **Image on disk = the resized JPEG that already passed through `processImageBuffer`.** Consistent with what Edna sees inline; no second re-encode; Veo accepts 1568px-edge JPEG references comfortably. Original-fidelity HD copy is deferred.
- **Videos save bytes verbatim, no transcoding inbound.** ffmpeg is in the container for `extract_frame.py`'s use, not on the host. 100 MB hard cap to bound disk usage; oversize gets a warn log and a text-only message with an "[attachment too large]" marker so Edna can apologize.
- **Inbox is agent-owned, no auto-cleanup.** Files persist until manually pruned or `groups/{folder}/` is wiped. Rotation policy is follow-up.
- **`VideoAttachment.path` is relative**, e.g. `inbox/2026-05-20T143012Z-F012345.mp4`. Same shape used in the marker text so Edna can paste it verbatim into a Veo command.

---

## Requirements

- **R1.** Edna's Slack channel accepts `video/mp4` and `video/quicktime` attachments inbound (in addition to the existing image MIME set).
- **R2.** Every accepted inbound image and video is written to `groups/{group_folder}/inbox/{filename}` on the host before the inbound message is dispatched to `onMessage`.
- **R3.** The relative paths of materialized attachments are injected into the inbound message text as a deterministic marker block (e.g., `[Attached files in inbox/:]` followed by one line per file), so Edna sees them in her prompt context.
- **R4.** Image attachments continue to flow as inline base64 in `NewMessage.images` so the Claude SDK content blocks keep working (no regression to visual-understanding behavior).
- **R5.** Inbound attachment filenames are derived from `{ISO_compact_ts}-{slack_file_id}.{ext_from_mime}` — Slack's user-supplied `file.name` is never used in the path.
- **R6.** Path-escape and group-isolation invariants are preserved: the materialized path is always inside `groups/{folder}/inbox/` and never escapes via path traversal.
- **R7.** Oversize attachments (>100 MB) are rejected with a warn log; Edna still receives the user's text plus a `[1 attachment skipped: too large]` marker so the user-facing behavior isn't silent failure.
- **R8.** Unsupported MIMEs continue to warn-log per the HEIC fix's discipline (`src/channels/slack.ts:166-171`) — no new silent drops introduced.
- **R9.** Edna's `groups/main/CLAUDE.md` documents the `inbox/` contract and the Veo-script consumption pattern (image → `-i`, video → `extract_frame.py --input`).
- **R10.** Existing inbound image behavior (HEIC/HEIF/AVIF acceptance, sharp re-encode, base64 delivery to SDK) is preserved unchanged for non-Veo flows.

---

## Key Technical Decisions

- **New module `src/media.ts` for MIME + path utilities.** `src/image.ts` stays focused on sharp re-encoding (`processImageBuffer`); the new module owns `isSupportedVideoMime`, `mediaExtForMime`, the inbox path builder, and a `materializeAttachment` helper that writes bytes under a validated group root. Keeps the sharp dependency narrow and lets media.ts be tested without a full image-decode round-trip.
- **`VideoAttachment` is a path-bearing type, not a base64 type.** `{ mediaType: 'video/mp4' | 'video/quicktime'; path: string; sizeBytes: number }`. Mirrors the *outbound* video shape (`{ kind: 'video', videoPaths }` in `src/channels/slack.ts:51-55`) — paths only, no inline bytes. The SDK has no video content-block channel today, so there's nothing to inline.
- **`ImageAttachment` gains optional `path?: string`.** Backward-compatible additive field. Slack populates it on materialization; the agent-runner ignores it (only consumes `mediaType` + `data`). The field exists for tests, future channels, and possible follow-up tooling that pairs base64 with path.
- **`NewMessage.videos?: VideoAttachment[]` is additive-only.** Same pattern as `images?` was added in the prior image rollout; no call site breaks because the field is optional.
- **Text marker format is parseable but human-readable.**

  ```
  {user's original text}

  [Attached files in inbox/:]
  - inbox/2026-05-20T143012Z-F012345.jpg (image/jpeg, 184 KB)
  - inbox/2026-05-20T143012Z-F012346.mp4 (video/mp4, 8.2 MB)
  ```

  Trailing block (not leading) so Edna's eye lands on the user's actual ask first. Inline base64 image content blocks (which are prepended to the prompt by `MessageStream.push`) keep their existing position above the text — the marker just tells Edna where the file *also* exists on disk.
- **Materialization is synchronous in the Slack handler.** The handler already `await`s each file download; writing to disk is one more await per file. No new queue, no new worker. If disk write fails, we fall through to "skip this file" with a warn, exactly as today's image fetch failure does (`src/channels/slack.ts:179-191`).
- **Defense-in-depth path validation.** The materialization helper validates that the resolved write target is under `groups/{folder}/inbox/` using the same predicate already in `src/ipc.ts:594` and `src/ipc.ts:659`. We construct the filename from sanitized inputs (ISO timestamp + Slack file ID + MIME-derived ext), so the check is belt-and-suspenders, not the primary defense.
- **Test-first execution posture for U3 and the media.ts helpers.** New domain behavior with security-relevant filesystem writes — start each unit with the test scaffold so the path-escape and MIME-rejection cases are nailed down before the I/O lands.
- **No changes to container-runner, group-queue, or agent-runner.** Videos don't propagate as structured fields; images keep their existing pipeline. The only orchestrator change is that `m.content` arrives with a marker block appended, which `formatMessages` (`src/router.ts:13-32`) already wraps as the per-message `<message>...</message>` body. The full marker travels through `formatMessages` → `runAgent` → `ContainerInput.prompt` → SDK without any per-layer awareness.

---

## System-Wide Impact

| Surface | Change |
|---|---|
| `src/media.ts` | **New file** — video MIME allowlist, MIME→extension map, inbox path builder, `materializeAttachment` helper |
| `src/image.ts` | No change |
| `src/types.ts` | Adds `VideoAttachment` and `NewMessage.videos?`; adds optional `ImageAttachment.path?` |
| `src/channels/slack.ts` | Inbound `files[]` loop now handles videos in addition to images, calls `materializeAttachment` for both, populates `videos[]` and `images[i].path`, appends inbox marker to `content` |
| `src/channels/slack.test.ts` | Adds video MIME inbound coverage, materialization assertions, marker assertions, oversize rejection, mixed image+video message |
| `src/media.test.ts` | **New file** — unit tests for the new helpers |
| `groups/main/CLAUDE.md` | Documents `inbox/` contract and Veo-consumption pattern |

Stakeholders:
- **End user (Edna's Boss).** Can now drop a photo or short video in Slack and ask Edna to animate, extend, or interpolate from it.
- **Edna.** New input surface; CLAUDE.md must teach her to look for the marker and pass relative paths to Veo scripts.
- **Ops/disk.** Inbox grows monotonically until manually pruned. 100 MB per-file cap bounds individual blast radius; rotation is follow-up.
- **Security.** New write path under per-group mount; reuses the established path-escape predicate; filenames synthesized from non-user-supplied components (ts + Slack file ID + MIME-derived ext).

---

## Implementation Units

### U1. Add `src/media.ts` — MIME helpers, inbox path, materialization

**Goal:** Create the small new module that owns video MIME acceptance, MIME-to-extension mapping, deterministic inbox filename construction, and a single `materializeAttachment` helper that writes bytes into a per-group inbox with defense-in-depth path validation.

**Requirements:** R1, R5, R6, R7

**Dependencies:** none

**Files:**
- `src/media.ts` (new)
- `src/media.test.ts` (new)

**Approach:**
- Export `SUPPORTED_VIDEO_MIMES` as a readonly Set (`video/mp4`, `video/quicktime`) and `isSupportedVideoMime(mime)` helper.
- Export `mediaExtForMime(mime)`: deterministic map. Image MIMEs all return `.jpg` (because `processImageBuffer` re-encodes everything to JPEG); video MIMEs return their native extension (`.mp4`, `.mov`).
- Export `inboxFilename(opts: { timestamp: Date; fileId: string; mime: string }): string` — returns just the basename (e.g., `2026-05-20T143012Z-F012345.jpg`). ISO timestamp compacted to remove colons (path-safe on all filesystems). File ID is sanitized to `/^[A-Z0-9]+$/` (Slack's format); any character outside that is rejected upstream — but as belt-and-suspenders, the helper rejects unsafe IDs with a thrown error.
- Export `MAX_VIDEO_BYTES = 100 * 1024 * 1024` constant.
- Export `materializeAttachment(opts: { bytes: Buffer; relName: string; groupFolder: string; groupsRoot: string }): Promise<string>` — returns the relative path (`inbox/...`) on success, or throws on path-escape. Internally:
  1. Compute `inboxDir = path.join(groupsRoot, groupFolder, 'inbox')`. Validate this is under `path.join(groupsRoot, groupFolder)` using `abs !== root && abs.startsWith(root + path.sep)` (the existing predicate from `src/ipc.ts:594`).
  2. Compute `absPath = path.join(inboxDir, relName)`. Re-validate that `absPath` is under `inboxDir` (catches any `relName` that contains `..` or absolute components — defense in depth even though we control `relName`).
  3. `fs.mkdirSync(inboxDir, { recursive: true })`.
  4. `fs.writeFileSync(absPath, bytes)`.
  5. Return `path.join('inbox', relName)`.

**Execution note:** Start with the test file — the path-escape and MIME-rejection cases are the security-relevant invariants.

**Patterns to follow:**
- `src/ipc.ts:564-618` `processImageIpcFile` — the path-escape predicate and exact `!== root && startsWith(root + path.sep)` check.
- `src/image.ts:11-23` — the `ReadonlySet`-of-MIMEs shape for the allowlist.
- `container/agent-runner/src/ipc-mcp-stdio.ts:14-33` `validateImagePath` — the same two-arm path-escape predicate, shows the established naming convention.

**Test scenarios:**
- **isSupportedVideoMime — happy:** Returns true for `video/mp4`, `video/quicktime`. False for `video/avi`, `video/webm`, undefined, empty string, `image/jpeg`.
- **mediaExtForMime — happy:** `image/jpeg → .jpg`, `image/png → .jpg` (re-encoded), `image/heic → .jpg`, `image/heif → .jpg`, `image/avif → .jpg`, `image/webp → .jpg`, `image/gif → .jpg`, `video/mp4 → .mp4`, `video/quicktime → .mov`. Unknown MIME throws.
- **inboxFilename — happy:** `{ timestamp: new Date('2026-05-20T14:30:12.000Z'), fileId: 'F012345', mime: 'image/jpeg' }` returns `2026-05-20T143012Z-F012345.jpg`.
- **inboxFilename — file ID validation:** A `fileId` containing `../` or non-alphanumeric chars throws with a clear error.
- **materializeAttachment — happy:** Writes bytes to a tmp groups dir, returns `inbox/{name}`, file exists at expected absolute path with expected size.
- **materializeAttachment — creates inbox dir:** When `inbox/` doesn't exist, the helper creates it (mkdir recursive).
- **materializeAttachment — path-escape via groupFolder:** A `groupFolder` of `../escaped` throws before any write happens; no file is created outside the groupsRoot.
- **materializeAttachment — path-escape via relName:** A `relName` of `../outside.jpg` throws; no file is written outside `inbox/`.
- **materializeAttachment — overwrite:** Calling twice with the same `relName` overwrites (deterministic filenames prevent collisions in practice, but assert the explicit semantic).
- **materializeAttachment — empty bytes:** Writes a zero-byte file successfully (Slack can deliver zero-byte uploads in pathological cases; we don't reject).

**Verification:** `npm test src/media.test.ts` passes all scenarios including the two path-escape arms.

---

### U2. Extend `src/types.ts` — VideoAttachment + NewMessage.videos + ImageAttachment.path

**Goal:** Carry the new attachment shapes through the type system without breaking any existing call sites.

**Requirements:** R2, R3, R4

**Dependencies:** none

**Files:**
- `src/types.ts`

**Approach:**
- Add a new exported interface:

  ```text
  VideoAttachment {
    mediaType: 'video/mp4' | 'video/quicktime';
    path: string;          // relative to /workspace/group/, e.g. 'inbox/2026-05-20T...mp4'
    sizeBytes: number;
  }
  ```

  Directional, not implementation spec — final TypeScript shape is the implementer's call as long as the three fields are present and the union for `mediaType` matches the supported set.

- Add `path?: string` to the existing `ImageAttachment` interface (`src/types.ts:45-48`). Optional; populated only when the channel materializes the image. The agent-runner `ImageAttachment` type duplicate at `container/agent-runner/src/message-stream.ts:1-4` is *not* updated (the field is unused container-side; keeping the container type narrow preserves the "container sees only what it consumes" invariant).
- Add `videos?: VideoAttachment[]` to `NewMessage` (`src/types.ts:50-64`), adjacent to `images?`.

**Patterns to follow:**
- `src/types.ts:45-48` `ImageAttachment` shape — same `mediaType` literal-union style.
- `src/types.ts:104-115` `Channel.sendImage?` / `sendVideo?` — the precedent for additive optional fields on shared interfaces.

**Test scenarios:**
- Test expectation: none — type-only change with no behavior. Validation is the downstream tests in U3 that consume the new fields.

**Verification:** `npm run build` (TypeScript compile) succeeds with no new errors. `npm test` continues to pass — no existing call site breaks because both new fields and the new optional are additive.

---

### U3. Slack inbound — accept videos, materialize all media, inject inbox marker

**Goal:** Extend the `files[]` loop in `src/channels/slack.ts` to handle videos in addition to images, write every accepted attachment to `groups/{folder}/inbox/`, and append a marker block to the message text listing the materialized paths.

**Requirements:** R1, R2, R3, R4, R5, R6, R7, R8, R10

**Dependencies:** U1, U2

**Files:**
- `src/channels/slack.ts`
- `src/channels/slack.test.ts`

**Approach:**
- Imports: add `materializeAttachment`, `isSupportedVideoMime`, `mediaExtForMime`, `inboxFilename`, `MAX_VIDEO_BYTES` from `../media.js`. Add `GROUPS_DIR` from `../config.js`. Add `VideoAttachment` from `../types.js`.
- Inside the `for (const file of files)` loop (currently `src/channels/slack.ts:160-192`), branch by MIME:
  - **Image branch (existing):** Same `processImageBuffer` → base64. After base64 is in hand, ALSO call `materializeAttachment` with the same buffer that went into sharp's output (i.e., decode-then-encode result from `processImageBuffer`) and the computed `relName`. Set `att.path = '<relative path>'` on the `ImageAttachment` and push.

    Implementation note: `processImageBuffer` today returns `{ mediaType, data }` — the JPEG bytes that were base64'd are not exposed. The smallest change is to add a sibling export that returns `{ mediaType, data, jpegBytes }` (or refactor `processImageBuffer` to return the raw `Buffer` and have the slack handler do base64). Implementer's call; both are equivalently safe. Test scenarios assume the resized JPEG is what's written.
  - **Video branch (new):** Check `isSupportedVideoMime(file.mimetype)`. If supported:
    1. Fetch via the existing `url_private_download` + Bearer token pattern (`src/channels/slack.ts:176-178`).
    2. Read content-length header; reject early if > `MAX_VIDEO_BYTES` with a warn log and a sentinel that adds an oversize marker to the outgoing text. (Slack provides `Content-Length` on its CDN responses; verify in U5 smoke test, but plan around it being reliable.)
    3. Read buffer, verify `byteLength <= MAX_VIDEO_BYTES` (belt-and-suspenders).
    4. Compute filename: `inboxFilename({ timestamp: new Date(parseFloat(msg.ts) * 1000), fileId: file.id!, mime: file.mimetype })`.
    5. Call `materializeAttachment({ bytes, relName, groupFolder: groups[jid].folder, groupsRoot: GROUPS_DIR })`.
    6. Push to a local `videos: VideoAttachment[]` array.
  - **Unsupported MIME branch (existing):** Keep the existing warn log unchanged (`src/channels/slack.ts:166-171`).
- After the file loop, build a marker block if any attachments were materialized:

  ```text
  [Attached files in inbox/:]
  - inbox/<filename> (<mime>, <human-size>)
  - ...
  ```

  Plus a separate marker for any oversize skips:

  ```text
  [1 attachment skipped: too large (limit 100 MB)]
  ```

  Append both blocks (separated by a blank line) to `content` before the `onMessage` call.
- Update the `onMessage` payload to include `videos: videos.length ? videos : undefined` alongside the existing `images:` field (`src/channels/slack.ts:197-207`).
- Drop semantics: if the message has neither text NOR images NOR videos AND was not just a metadata ping, still drop silently to match the current "user uploaded a nothing" behavior (`src/channels/slack.ts:194-195`).

**Execution note:** Start with the test file extension. Lock down the new MIME branch's happy path, the oversize rejection, the marker shape, the image+video mixed case, and the path-escape regression test before touching the handler.

**Patterns to follow:**
- `src/channels/slack.ts:148-208` — the existing files loop and `onMessage` shape.
- `src/channels/slack.ts:66-78` — `botToken` handling (already correct; reuse the same bearer auth pattern for video downloads).
- `src/channels/slack.ts:166-171` — the established warn-log discipline for dropped attachments (the HEIC fix's "silent drops are debugging poison" lesson — carry it into the new oversize and unsupported-video branches).
- `src/channels/slack.test.ts:910-1100` — existing inbound image test structure (`okFetch()` helper, `createMessageEvent({files: [...]})` builder, mocked `processImageBuffer`).

**Test scenarios:**
- **Happy path — single image:** Inbound message with one `image/jpeg` file: image is fetched, `processImageBuffer` is called, the JPEG bytes are written to `groups/{folder}/inbox/{ts}-{fileId}.jpg`, the `onMessage` payload has `images: [{ mediaType: 'image/jpeg', data: <base64>, path: 'inbox/...' }]`, and `content` ends with the marker block listing that one path.
- **Happy path — single video:** Inbound `video/mp4` file: bytes fetched, written to `inbox/{ts}-{fileId}.mp4`, `onMessage` payload has `videos: [{ mediaType: 'video/mp4', path: 'inbox/...', sizeBytes: N }]` and no `images`. Content marker lists the video path.
- **Happy path — mixed:** Inbound message with one image AND one video: both materialized, both marker lines present in order (image first, then video), `images` and `videos` both populated.
- **Mac QuickTime:** A `video/quicktime` upload is accepted and written with `.mov` extension.
- **Unsupported video MIME:** `video/webm` falls through to the existing unsupported-MIME warn log (no new behavior); marker block is absent if no other attachments succeeded.
- **Unsupported MIME with text:** A text+`video/webm` message arrives — text is preserved verbatim, no marker is appended, no file written, warn log emitted.
- **Oversize video:** A video whose `Content-Length` exceeds `MAX_VIDEO_BYTES` is rejected before the body is read. `videos` is empty. The marker block contains `[1 attachment skipped: too large (limit 100 MB)]`. Warn log emitted.
- **Oversize video — buffer check fallback:** When `Content-Length` is missing/lying and the actual buffer exceeds the cap, the post-fetch size check rejects the file with the same marker. (Mock the fetch to return a buffer larger than the header advertised.)
- **Path-escape regression (file ID):** A pathological Slack response with `file.id = '../escape'` is rejected at `inboxFilename` validation; no file is written, no marker added, warn log emitted.
- **Fetch failure carries forward:** When `url_private_download` returns 404 or 401, the existing fail-soft path runs unchanged (`src/channels/slack.ts:179-184`); no file written; warn log emitted.
- **No bot token in inbox path:** The materialized file path under `groups/...` does NOT contain or leak the Slack bot token (sanity check — token is only in the Authorization header during fetch).
- **Group-isolated:** A message arriving on group A's JID writes to `groups/A/inbox/`, never to `groups/B/inbox/`.
- **Group not registered:** A message on an unregistered JID returns early per the existing guard (`src/channels/slack.ts:115-118`); no fetch, no write.
- **Marker absent when nothing materialized:** A text-only message produces a `content` field equal to the user's text (no trailing marker block).
- **Marker formatting:** With two materialized files, the marker block matches the literal expected shape (blank line separator, header, one line per file with `- inbox/{name} ({mime}, {human-size})`).

**Verification:** `npm test src/channels/slack.test.ts` passes all new and existing tests. Manual: start the dev process, send Edna a JPEG and an MP4 in Slack, confirm both land at `groups/main/inbox/...` and Edna's transcript shows the marker block.

---

### U4. Update `groups/main/CLAUDE.md` — inbox contract + Veo consumption pattern

**Goal:** Teach Edna how to discover inbound media and how to feed it into the Veo scripts she already knows about.

**Requirements:** R9

**Dependencies:** U3 (the marker block must exist before documenting it)

**Files:**
- `groups/main/CLAUDE.md`

**Approach:**
Add a new "Inbound Media (inbox/)" section after the existing video-generation strategy block (`groups/main/CLAUDE.md:21-43`). Cover:

- **Where to look.** Every Slack message with attachments will end with `[Attached files in inbox/:]` followed by one line per file. The paths are relative to your working directory (`/workspace/group/`).
- **Image attachment usage.** Pass the relative path to `generate_video.py -i`, e.g. `uv run /app/skills/veo/scripts/generate_video.py --prompt "..." --filename out.mp4 -i inbox/2026-05-20T143012Z-F012345.jpg`. Up to 3 image refs total; combine with `--last-frame` for first/last interpolation.
- **Video attachment usage.** Veo cannot ingest video directly. First extract a frame: `uv run /app/skills/veo/scripts/extract_frame.py --input inbox/{...}.mp4 --mode last --filename ref-last.png`. Then pass `ref-last.png` to `generate_video.py -i`.
- **The image is also inline.** Image attachments arrive both as a visual content block (so you can describe and reason about the image) AND as a file in `inbox/`. The inline view and the file are the same JPEG — same resolution, same content.
- **Lifecycle.** Files in `inbox/` persist; the orchestrator does not auto-delete them. You may delete them when done if disk is a concern, but Edna's Boss may also want to reference them later, so prefer to leave them.
- **Oversize markers.** If a `[N attachment(s) skipped: too large (limit 100 MB)]` line appears, apologize to the user and ask them to compress or trim the clip.

**Patterns to follow:**
- `groups/main/CLAUDE.md:21-43` — existing video-generation strategy guide (the Edna persona, the prose tone, the decision-tree shape).
- `container/skills/veo/SKILL.md:78-104` — the existing `extract_frame.py` documentation that this section will link to in spirit.

**Test scenarios:**
- Test expectation: none — prose documentation. Validation is the smoke test in the Verification Plan below: Edna receives a message with a real attached `.jpg`, picks `generate_video.py -i inbox/...`, and emits a video that visibly references the attached image.

**Verification:** Edna's session in a dev container, sent "animate this" with a JPEG attachment, results in a `generate_video.py` invocation whose `-i` flag points at the materialized inbox path (not at a hallucinated URL, not at the inline content block, not at a non-existent path).

---

### U5. End-to-end smoke test fixture (optional but recommended)

**Goal:** A pytest-shaped fixture that exercises the full inbound→Veo path with a stubbed Veo API, so regressions in the marker block, path materialization, or the agent's Veo invocation are caught before they reach real Slack traffic.

**Requirements:** R1, R2, R3, R9

**Dependencies:** U1, U2, U3, U4

**Files:**
- `src/channels/slack.test.ts` (extend with one end-to-end shape) — *or* a new `src/inbound-media-e2e.test.ts` if the slack test file is already at its size ceiling.

**Approach:**
- Mock the Slack files[] fetch with a small JPEG fixture (a few KB) and a small MP4 fixture (8-10 KB; ffmpeg can generate one in CI if needed).
- Drive the inbound handler with a `createMessageEvent({ files: [jpeg, mp4] })` shape.
- Assert: both files land in a tmp groups dir, the `onMessage` payload has the expected `images`, `videos`, and `content` (with marker), and the marker paths match the actual files written.
- Do NOT exercise the live Veo API; just confirm the orchestrator surface is correct so Edna's prompt context is what we expect.

**Patterns to follow:**
- `src/channels/slack.test.ts:910-1100` — the existing inbound image test patterns.

**Test scenarios:**
- **Mixed image + video flow:** Full path from inbound event to `onMessage` callback, asserting all of: file presence on disk, payload shape, marker block contents, no warn logs.
- **Marker text matches files written:** Re-read the marker lines from `content`, parse the paths, confirm each parsed path corresponds to a real file on disk in the tmp groups dir.

**Verification:** `npm test` includes this case; CI green.

---

## Output Structure

No new directory hierarchy; only one new file plus modifications. Skipping a tree.

---

## Scope Boundaries

**In scope:** R1-R10 above. Slack-only. `video/mp4` and `video/quicktime` (covers iPhone uploads). Image+video materialization to `groups/{folder}/inbox/`. Marker injection. Edna CLAUDE.md update.

**Out of scope:**
- WhatsApp inbound media (same pattern can be ported later).
- Telegram inbound media.
- Discord inbound media.
- Gmail inbound media (attachments).
- Generic file types: PDFs, audio, documents, ZIP archives. Image and video only.
- Inline video content blocks for the Claude SDK (the SDK has no `video` content-block type; nothing to inline).
- Original-fidelity image preservation (we save the resized JPEG that already passed through sharp; HD copy is follow-up).
- Inbound video transcoding on the host (ffmpeg lives in the container; the host writes bytes verbatim).
- Veo-side direct-base64 ingestion (Veo's SDK accepts `Image(image_bytes=...)` — could in principle skip the disk write — but extract_frame.py and the established Veo workflow assume on-disk paths; rewiring that is a separate, larger refactor).
- Inbox rotation/cleanup policy.
- Attachment metadata sidecar files (e.g., a `.json` next to each file with sender, timestamp, original filename).

### Deferred to Follow-Up Work

- **WhatsApp inbound media.** Port the same materialization shape to the WhatsApp channel handler. Same `media.ts` utilities, same `inbox/` target, same marker block format.
- **Telegram inbound media.** Same shape.
- **Inbox rotation/quota.** Decide on a cleanup policy (oldest-N, age-based, manual-only) once we see real usage volume.
- **HD original retention.** Optionally write an `inbox/originals/` copy of the un-resized image bytes for cases where Veo would benefit from 4K input.
- **Metadata sidecars.** Write `inbox/{name}.meta.json` per file with sender, original filename, timestamp, source channel — useful for Edna to reference provenance without prompting the user.
- **Generic attachment passthrough.** Allow `.pdf`/`.txt`/`.md` attachments into inbox/ for reading (not Veo) workflows.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Slack `Content-Length` is missing or misreports, causing oversize check to fail before the buffer check | Medium | Medium | Belt-and-suspenders: also check `buf.byteLength` after the fetch completes; reject either way |
| `materializeAttachment` write succeeds but the agent prompt is built before the file is durable on disk (filesystem race) | Low | Medium | The Slack handler `await`s the write before calling `onMessage`; the queue and IPC layers run after `onMessage`, so the file is guaranteed durable by the time the agent reads it |
| Inbox fills disk over time | Medium | Medium | 100 MB per-file cap bounds blast radius; rotation policy is deferred but documented |
| Materialized image differs from inline base64 (e.g., second sharp re-encode introduces drift) | Low | Low | Plan reuses the same JPEG bytes that produced the base64; one encode pass, two outputs (base64 + disk) |
| Edna doesn't read the marker block and tries to reference the inline image as a URL | Medium | Low | CLAUDE.md guidance + the deterministic marker format (with literal `inbox/` prefix) makes the path discoverable |
| User uploads a non-`/^[A-Z0-9]+$/` Slack file ID (synthetic test traffic, future Slack format change) | Low | Low | `inboxFilename` throws; the file is dropped with a warn log; no path escape possible |
| Container-side cache invalidation gotcha: existing groups have a stale `data/sessions/{folder}/agent-runner-src/` cache | Medium | Medium | This branch does NOT touch `container/agent-runner/src/`, so no cache-copy step is needed. Document this explicitly in the PR description so anyone testing against a long-lived session knows they don't need to invalidate |
| `processImageBuffer` refactor to expose JPEG bytes breaks existing image-only flows | Low | Medium | Either keep `processImageBuffer` returning its current shape and have the slack handler do its own `Buffer.from(data, 'base64')` decode, OR add a sibling function. Test coverage stays the same; only the call-site wiring changes |
| MP4 from iPhone uploaded as `video/mp4` but actually H.265/HEVC inside a Quicktime container — Veo's `extract_frame.py` (ffmpeg) handles it, but render quality may suffer | Medium | Low | Veo + ffmpeg handle HEVC fine for frame extraction; if a specific clip fails, Edna can ask the user to re-export. Document in CLAUDE.md |

---

## Deferred Implementation Notes

- **Whether to refactor `processImageBuffer` or add a sibling.** Decision deferred to implementation: both shapes are equally safe. The implementer picks based on which keeps `src/image.ts` tidier.
- **Exact human-size formatting in the marker block** (`184 KB`, `8.2 MB`, etc.). Trivial — implementer picks an existing helper or writes a one-liner. Test asserts the file is present, not the exact size string.
- **Whether to log every materialized attachment at `info`, or only the unsupported/oversize/error cases at `warn`.** Lean info-level for successes (one line per file with redacted size + MIME) — matches `slack.ts:258` style.
- **Whether to add a `Cache-Control: no-store`-equivalent on the fetch headers** to discourage Slack CDN edge caching weirdness. Probably unnecessary, but worth a glance during U3 review.
- **The exact `Content-Length` reliability across Slack CDN responses.** Empirically observed across the image path today — assume it's present for video too; the buffer-size fallback covers the case where it isn't.

---

## Verification Plan

1. **Unit tests** — `npm test src/media.test.ts src/channels/slack.test.ts` green.
2. **Type check** — `npm run build` clean.
3. **End-to-end smoke (manual, dev container)**:
   - Send Edna a JPEG with "animate this". Confirm:
     - `groups/main/inbox/{ts}-{fileId}.jpg` exists on host.
     - Inside the container, `/workspace/group/inbox/{...}.jpg` exists (bind mount working).
     - Edna's prompt context (visible in `data/sessions/.../*.json` or the agent log) contains the marker block with the correct path.
     - Edna invokes `generate_video.py -i inbox/{...}.jpg` (not a hallucinated path).
     - The output MP4 visibly references the input image.
   - Send Edna a 10-second MP4 with "extend this". Confirm:
     - `groups/main/inbox/{ts}-{fileId}.mp4` exists.
     - Marker block lists the video path.
     - Edna invokes `extract_frame.py --input inbox/{...}.mp4 --mode last --filename ref-last.png` followed by `generate_video.py -i ref-last.png`.
     - Output is a continuous extension of the input clip.
4. **Oversize check (manual)** — upload a >100 MB MP4 and confirm the marker shows `[1 attachment skipped: too large]` and Edna apologizes politely.
5. **Path-escape regression (unit-only)** — `materializeAttachment` rejects pathological inputs as covered in U1 test scenarios; no need for a live attempt.

---

## Dependencies / Prerequisites

- Existing: per-group mount at `groups/{folder}/` (read-write) — `src/container-runner.ts:104-116`.
- Existing: Slack `files:read` scope (already required for inbound images).
- Existing: ffmpeg in container (for `extract_frame.py`) — landed in U1 of the outbound video plan.
- New: nothing external. All new code is host-side TypeScript plus one CLAUDE.md prose update.

---

## Relationship to Existing Work

This plan is the inbound follow-up to `docs/plans/2026-05-17-001-feat-edna-video-generation-plan.md`, which explicitly deferred "Inbound video understanding (Edna analyzing user-sent videos beyond frame extraction)" to follow-up work. Both plans together complete Edna's symmetric video capability: the outbound plan made her produce videos; this plan makes her consume them.
