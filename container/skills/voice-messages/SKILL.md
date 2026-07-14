---
name: voice-messages
description: >-
  Understand voice notes/audio recordings sent by the user, and reply with voice
  when appropriate. Use whenever an incoming message includes an audio or voice
  attachment (a line like "[audio: … — saved to /workspace/inbox/…]"), or when the
  user asks you to answer by voice. Transcribe incoming audio to text, understand
  it, respond (translating when asked), and send a spoken voice-note reply when the
  user spoke to you or requested it.
---

# Voice & Audio Messages

You can't hear audio directly. To understand a voice note or audio recording,
transcribe it to text first, then work with the text exactly as if the user had
typed it.

## When this applies

An incoming message shows an attachment line such as:

```
[audio: attachment-1748450000000.ogg — saved to /workspace/inbox/ABC123/attachment-1748450000000.ogg]
```

WhatsApp voice notes arrive as `.ogg` (Opus). Other channels may send `.mp3`,
`.m4a`, `.wav`, `.mp4`, `.webm`, etc. All of these transcribe fine.

## Steps

1. **Get the file path** — take the path after `saved to`
   (e.g. `/workspace/inbox/ABC123/attachment-….ogg`).
2. **Transcribe** — call the `transcribe_audio` tool (from the `openai` MCP
   server):
   - `file_path`: the saved path from step 1.
   - `output_dir`: `/tmp` (the transcript file is throwaway — you get the text
     back in the tool response, so don't clutter the workspace).
   - `language`: usually leave unset; Whisper auto-detects. Only set it (ISO-639-1,
     e.g. `he` for Hebrew) if auto-detection clearly picked the wrong language.
   - The tool returns the transcript in its response `text`.
3. **Understand & respond** — treat the transcript as the user's message:
   - Whisper transcribes in the **original** spoken language (so Hebrew speech →
     Hebrew text).
   - If the user asked you to translate, give the translation. Otherwise reply in
     the user's language.
   - Answer questions, take actions, etc. — just as you would for a typed message.

## Replying with voice

Mirror the user's channel: if they sent you a **voice note**, reply with a voice
note too. Also reply by voice whenever they ask you to (e.g. "answer me out loud",
"ענה לי בהקלטה"). If they typed text, reply with text.

Steps:

1. **Write the reply** as you normally would, then keep it **short and natural**
   for speech — no markdown, no bullet lists, no long URLs. A voice note should be
   a sentence or three, not an essay.
2. **Generate the audio** — call the `generate_speech` tool (OpenAI MCP):
   - `input`: your reply text.
   - `response_format`: `opus` (this is what makes it render as a real WhatsApp
     voice note).
   - `output_dir`: `/tmp`.
   - `voice`: pick one and stay consistent (e.g. `nova`, `onyx`, `shimmer`). If the
     user has a preferred voice, record it in `CLAUDE.local.md` and reuse it.
   - It works in many languages, including Hebrew — just pass the reply text in the
     target language.
   - The tool returns the saved path (e.g. `/tmp/speech-….opus`).
3. **Send it** — call `send_file` with `path` set to that saved path. Send the
   voice note on its own (no `text`); if you also want to show written text, send it
   as a separate `send_message`.

## Notes

- **`.ogg` works.** The tool's own description lists mp3/mp4/m4a/wav/webm and omits
  `.ogg`, but WhatsApp's `.ogg` Opus voice notes transcribe correctly — pass them
  through unchanged.
- **Never** ask the user to type out what they said — transcription is the whole point.
- If transcription fails (corrupt or unreadable audio), tell the user briefly and
  ask them to re-record or type it.
- **Video files**: a video's audio track can be transcribed the same way — pass the
  saved video path (e.g. `.mp4`) to `transcribe_audio`. You can't watch the visuals
  frame-by-frame, so focus on the spoken content unless the user specifically needs
  the picture described.
