# Verify Voice Transcription (Chat SDK channels)

Send a voice memo (or any audio attachment) from a Chat SDK-bridged channel
(Discord, Slack, …) to a channel where your NanoClaw bot has access. The agent should receive the audio file
alongside an inline `[Voice: <transcript>]` block and respond to the
transcribed content.

If nothing transcribes:

```bash
tail logs/nanoclaw.log | grep -i "Voice transcription\|whisper"
```

`Voice transcription failed` indicates ffmpeg or whisper-cli returned an
error — check both are installed and the model file path is correct. See
SKILL.md "Troubleshooting" for the full checklist.

A successful transcription leaves no specific log line by design; the
transcript flows through with the rest of the inbound-message processing.
