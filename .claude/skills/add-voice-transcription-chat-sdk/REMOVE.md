# Remove Voice Transcription (Chat SDK channels)

The transcription hook is a no-op when `WHISPER_BIN` is unset, so the lightest
"removal" is to just unset the env var:

1. Remove `WHISPER_BIN` (and `WHISPER_MODEL` if set) from `.env`
2. Sync env into the container: `cp .env data/env/env`
3. Restart the service

Voice attachments will then flow through as before — plain audio placeholders,
no transcription.

## Full removal (also deletes the code)

If you want to remove the code as well:

1. Delete `src/transcription.ts` and `src/transcription.test.ts`
2. Revert `src/channels/chat-sdk-bridge.ts` to its pre-skill version:
   ```bash
   git fetch upstream main
   git checkout upstream/main -- src/channels/chat-sdk-bridge.ts
   ```
3. Rebuild: `pnpm run build`

This leaves your model files in `data/models/` untouched — delete them
manually if you want the disk space back (`rm -rf data/models/ggml-*.bin`).
