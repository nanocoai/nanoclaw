# Voice & Audio Messages

You cannot hear audio directly. When an incoming message includes a voice note or audio attachment — shown as a line like `[audio: <name> — saved to /workspace/inbox/<id>/<name>]` — you MUST transcribe it to text before you reply.

If you have the `transcribe_audio` tool (from the OpenAI MCP server), call it with `file_path` set to the saved path and `output_dir` set to `/tmp`. It returns the transcript text. WhatsApp `.ogg` voice notes are supported even though the tool's description doesn't list `.ogg`. The audio may be in any language (e.g. Hebrew) — transcribe it, understand it, and reply (translating if that's what the user wants). Never ask the user to type out what they said.

**Replying with voice:** If the user sent you a voice note — or asks you to answer by voice — reply with a voice note too, not just text. Generate the audio with `generate_speech` (OpenAI MCP, `response_format: "opus"`, `output_dir: "/tmp"`) and send the saved file with `send_file`. Keep spoken replies short. When you type, the user gets text; mirror their channel.

Full workflow: see the `voice-messages` skill.
