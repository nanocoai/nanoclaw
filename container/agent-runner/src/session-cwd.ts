import fs from 'fs';
import path from 'path';

export function findSessionTranscript(
  configDir: string | undefined,
  sessionId: string | undefined,
): string | undefined {
  if (!configDir || !sessionId) return undefined;
  const projectsDir = path.join(configDir, 'projects');
  if (!fs.existsSync(projectsDir)) return undefined;

  for (const entry of fs.readdirSync(projectsDir)) {
    const transcript = path.join(projectsDir, entry, `${sessionId}.jsonl`);
    if (fs.existsSync(transcript)) return transcript;
  }
  return undefined;
}

export function readTranscriptCwd(
  transcriptPath: string | undefined,
): string | undefined {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return undefined;
  const lines = fs.readFileSync(transcriptPath, 'utf-8').trim().split('\n').reverse();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { cwd?: unknown };
      if (typeof parsed.cwd === 'string' && parsed.cwd.trim()) return parsed.cwd;
    } catch {
      // 跳过损坏行，继续读更早的 transcript 记录。
    }
  }
  return undefined;
}

export function resolveQueryCwdForSession(input: {
  configDir?: string;
  sessionId?: string;
  defaultCwd: string;
}): {
  cwd: string;
  transcriptPath?: string;
  transcriptCwd?: string;
  usedTranscriptCwd: boolean;
} {
  const transcriptPath = findSessionTranscript(input.configDir, input.sessionId);
  const transcriptCwd = readTranscriptCwd(transcriptPath);
  if (transcriptCwd && transcriptCwd !== input.defaultCwd && fs.existsSync(transcriptCwd)) {
    return {
      cwd: transcriptCwd,
      transcriptPath,
      transcriptCwd,
      usedTranscriptCwd: true,
    };
  }
  return {
    cwd: input.defaultCwd,
    transcriptPath,
    transcriptCwd,
    usedTranscriptCwd: false,
  };
}
