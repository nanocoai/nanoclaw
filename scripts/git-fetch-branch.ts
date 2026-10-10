// Fetch the branch into the ref used by registry copies, even in a single-branch clone.
function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function gitFetchBranchCommand(remote: string, branch: string): string {
  const refspec = `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`;
  return `git fetch ${shellQuote(remote)} ${shellQuote(refspec)}`;
}
