const SECRET_PATTERNS = [
  /(?:Authorization\s*:\s*)?Bearer\s+[A-Za-z0-9._~-]+/gi,
  /\b(?:nde_live_|ndstaging_|ndeproduction_)[A-Za-z0-9._~-]+\b/gi,
  /body\s*=\s*(?:\{[^\n]*\}|\[[^\n]*\]|[^\s]+)/gi,
  /\/workspace\/downloads\/[^\s"']+/g,
];

export function redactError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const pattern of SECRET_PATTERNS) message = message.replace(pattern, '[REDACTED]');
  return message.slice(0, 500);
}
