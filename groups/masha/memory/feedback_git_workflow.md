---
name: Git workflow — always PR, never direct push
description: Never push branches directly; always open a PR and let the user approve
type: feedback
originSessionId: 474441ee-4277-4833-b2b6-d12824242fcf
---
Never push anything to remote — not a branch, not a commit, nothing — without explicit user approval.

**Why:** The user wants full control over what goes to the remote repo. Any push, even of a feature branch, must be approved first.

**How to apply:**
1. Commit locally only — CS and Config files only, never DLL or project files (.csproj, .sln, bin/, obj/)
2. Push and open PR automatically — no need to wait for explicit approval before each push
3. PR must have a clear description explaining exactly what changed and why
4. User reviews the PR and merges — never merge yourself
