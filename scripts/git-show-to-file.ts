import { posix } from 'node:path';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// Keep redirection away from the destination until Git has succeeded. The
// sibling temporary directory keeps the final move on the same filesystem;
// its payload gets normal file permissions, or preserves the existing mode.
// Use a subshell so cleanup never replaces the caller's EXIT trap.
export function gitShowToFileCommand(revision: string, source: string, destination: string): string {
  const target = shellQuote(destination);
  const pattern = posix.join(posix.dirname(destination), `.${posix.basename(destination)}.XXXXXX`);
  return `( ${[
    `[ ! -d ${target} ]`,
    `nc_copy_dir=$(mktemp -d ${shellQuote(pattern)})`,
    `trap 'rm -rf -- "$nc_copy_dir"' EXIT`,
    `{ if [ -f ${target} ]; then cp -p -- ${target} "$nc_copy_dir/payload"; fi; }`,
    `git show ${shellQuote(`${revision}:${source}`)} > "$nc_copy_dir/payload"`,
    `mv -- "$nc_copy_dir/payload" ${target}`,
  ].join(' && ')} )`;
}
