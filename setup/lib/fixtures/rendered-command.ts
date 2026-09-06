/**
 * Test helper: reconstruct what the shell actually sees, the inverse of
 * skill-apply's `bindShell`.
 *
 * `hostExec` runs `bash -c <command> nanoclaw-skill <args…>`, so a bound prompt
 * value reaches the shell as a positional parameter (`${1}`) instead of being
 * pasted into the command text — that is what keeps secrets out of the command
 * string. `bindShell` wraps each reference in the quote context the skill
 * author wrote, and bash strips those quotes before the command runs, so a
 * fixture comparing against command text wants the same joined form.
 *
 * Only a MATCHED pair is removed. A `${1}` already inside a double-quoted
 * string owns no quotes of its own, and eating a neighbour's would corrupt the
 * command.
 */
export function renderedCommand(command: string, args: readonly string[] = []): string {
  return command.replace(
    /'"\$\{(\d+)\}"'|"\$\{(\d+)\}"|\$\{(\d+)\}/g,
    (_match, singleQuoted?: string, doubleQuoted?: string, bare?: string) =>
      args[Number(singleQuoted ?? doubleQuoted ?? bare) - 1] ?? '',
  );
}
