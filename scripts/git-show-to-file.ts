import { posix } from 'node:path';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function gitShowToFileCommand(revision: string, source: string, destination: string): string {
  const tempPattern = posix.join(posix.dirname(destination), `.${posix.basename(destination)}.XXXXXX`);
  return [
    `temp_file=$(mktemp ${shellQuote(tempPattern)})`,
    `trap 'rm -f -- "$temp_file"' EXIT`,
    `git show ${shellQuote(`${revision}:${source}`)} > "$temp_file"`,
    `mv -- "$temp_file" ${shellQuote(destination)}`,
    `trap - EXIT`,
  ].join(' && ');
}
