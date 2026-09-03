/**
 * Structured status block output for setup steps.
 * Each step emits a block that the SKILL.md LLM can parse.
 */

export function emitStatus(step: string, fields: Record<string, string | number | boolean>): void {
  const lines = [`=== NANOCLAW SETUP: ${step} ===`];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push('=== END ===');
  console.log(lines.join('\n'));
}
