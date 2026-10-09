/**
 * MCP tool: transcribe audio files.
 *
 * Wraps the core transcribeAudio() function as an explicit tool so agents can:
 *   - Transcribe arbitrary files outside the auto-injection inbound flow
 *   - Access the raw result (source, durationMs, model) for disclosure
 *
 * Auto-injection in the poll loop is the default UX — this tool is for
 * advanced cases where the agent needs explicit control.
 */
import { transcribeAudio } from '../transcription.js';
import { registerTools } from './server.js';

registerTools([
  {
    tool: {
      name: 'transcribe',
      description:
        'Transcribe an audio file to text via local Whisper inside the container. ' +
        'Sovereign: audio never leaves the machine. Returns the transcript text plus ' +
        'the source label (local-whisper) and timing for disclosure.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          filePath: {
            type: 'string',
            description: 'Absolute path to the audio file (e.g. /workspace/attachments/abc123)',
          },
        },
        required: ['filePath'],
      },
    },
    async handler(args) {
      const { filePath } = args as { filePath: string };

      try {
        const result = await transcribeAudio(filePath);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Transcription failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  },
]);
