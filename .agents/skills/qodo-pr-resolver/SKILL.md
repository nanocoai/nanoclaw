---
name: qodo-pr-resolver
description: Review and resolve PR issues with Qodo - get AI-powered code review issues and fix them interactively (GitHub, GitLab, Bitbucket, Azure DevOps)
version: 0.3.0
triggers:
  - qodo.?pr.?resolver
  - pr.?resolver
  - resolve.?pr
  - qodo.?fix
  - fix.?qodo
  - qodo.?review
  - review.?qodo
  - qodo.?issues?
  - show.?qodo
  - get.?qodo
  - qodo.?resolve
---

# Qodo PR Resolver

Fetch Qodo review issues for your current branch's PR/MR, fix them interactively or in batch, and reply to each inline comment with the decision. Supports GitHub, GitLab, Bitbucket, and Azure DevOps.

## Prerequisites

### Required Tools:
- **Git** - For branch operations
- **Git Provider CLI** - One of: `gh` (GitHub), `glab` (GitLab), `bb` (Bitbucket), or `az` (Azure DevOps)

**Installation and authentication details:** See [providers.md](./resources/providers.md) for provider-specific setup instructions.

### Required Context:
- Must be in a git repository
- Repository must be hosted on a supported git provider (GitHub, GitLab, Bitbucket, or Azure DevOps)
- Current branch must have an open PR/MR
- PR/MR must have been reviewed by Qodo (pr-agent-pro bot, qodo-merge[bot], etc.)

### Quick Check:
```bash
git --version                                    # Check git installed
git remote get-url origin                        # Identify git provider
```

See [providers.md](./resources/providers.md) for provider-specific verification commands.

## Understanding Qodo Reviews

Qodo (formerly Codium AI) is an AI-powered code review tool that analyzes PRs/MRs with compliance checks, bug detection, and code quality suggestions.

### Bot Identifiers
Look for comments from: **`pr-agent-pro`**, **`pr-agent-pro-staging`**, **`qodo-merge[bot]`**, **`qodo-ai[bot]`**

### Review Comment Types
1. **PR Compliance Guide** 🔍 - Security/ticket/custom compliance with 🟢/🟡/🔴/⚪ indicators
2. **PR Code Suggestions** ✨ - Categorized improvements with importance ratings
3. **Code Review by Qodo** - Structured issues with 🐞/📘/📎 sections and agent prompts (most detailed)

## Instructions

When the user asks for a code review, to see Qodo issues, or fix Qodo comments:

### Step 0: Check code push status

Check for uncommitted changes, unpushed commits, and get the current branch.

#### Scenario A: Uncommitted changes exist

- Inform: "⚠️ You have uncommitted changes. These won't be included in the Qodo review."
- Ask: "Would you like to commit and push them first?"
- If yes: Wait for user action, then proceed to Step 1
- If no: Warn "Proceeding with review of pushed code only" and continue to Step 1

#### Scenario B: Unpushed commits exist

(no uncommitted changes)

- Inform: "⚠️ You have N unpushed commits. Qodo hasn't reviewed them yet."
- Ask: "Would you like to push them now?"
- If yes: Execute `git push`, inform "Pushed! Qodo will review shortly. Please wait ~5 minutes then run this skill again."
- Exit skill (don't proceed - Qodo needs time to review)
- If no: Warn "Proceeding with existing PR review" and continue to Step 1

#### Scenario C: Everything pushed

(both uncommitted changes and unpushed commits are empty)

- Proceed to Step 1

### Step 1: Detect git provider

Detect git provider from the remote URL (`git remote get-url origin`).

See [providers.md](./resources/providers.md) for provider detection patterns.

### Step 2: Find the open PR/MR

Find the open PR/MR for this branch using the provider's CLI.

See [providers.md § Find Open PR/MR](./resources/providers.md#find-open-prmr) for provider-specific commands.

### Step 3: Get Qodo review comments

Get the Qodo review comments using the provider's CLI.

Qodo typically posts both a **summary comment** (PR-level, containing all issues) and **inline review comments** (one per issue, attached to specific lines of code). You must fetch both.

See [providers.md § Fetch Review Comments](./resources/providers.md#fetch-review-comments) for provider-specific commands.

Look for comments where the author is "qodo-merge[bot]", "pr-agent-pro", "pr-agent-pro-staging" or similar Qodo bot name.

#### Step 3a: Check if review is still in progress

- If any comment contains "Come back again in a few minutes" or "An AI review agent is analysing this pull request", the review is still running
- In this case, inform the user: "⏳ Qodo review is still in progress. Please wait a few minutes and try again."
- Exit early - don't try to parse incomplete reviews

#### Step 3b: Deduplicate issues

Deduplicate issues across summary and inline comments:

- Qodo posts each issue in two places: once in the **summary comment** (PR-level) and once as an **inline review comment** (attached to the specific code line). These will share the same issue title.
- Qodo may also post multiple summary comments (Compliance Guide, Code Suggestions, Code Review, etc.) where issues can overlap with slightly different wording.
- Deduplicate by matching on **issue title** (primary key - the same title means the same issue):
  - If an issue appears in both the summary comment and as an inline comment, merge them into a single issue
  - Prefer the **inline comment** for file location (it has the exact line context)
  - Prefer the **summary comment** for severity, type, and agent prompt (it is more detailed)
  - **IMPORTANT:** Preserve each issue's **inline review comment ID** — you will need it later (Step 8) to reply directly to that comment with the decision
- Also deduplicate across multiple summary comments by location (file path + line numbers) as a secondary key
- If the same issue appears in multiple places, combine the agent prompts

### Step 4: Parse and display the issues

- Extract the review body/comments from Qodo's review
- Parse out individual issues/suggestions
- **IMPORTANT: Preserve Qodo's exact issue titles verbatim** — do not rename, paraphrase, or summarize them. Use the title exactly as Qodo wrote it.
- **IMPORTANT: Preserve Qodo's original ordering** — display issues in the same order Qodo listed them. Qodo already orders by severity.
- Extract location, issue description, and suggested fix
- Extract the agent prompt from Qodo's suggestion (the description of what needs to be fixed)

#### Severity mapping

Derive severity from Qodo's action level and position:

1. **Action level determines severity range:**
   - **"Action required"** issues → Can only be 🔴 CRITICAL or 🟠 HIGH
   - **"Review recommended"** / **"Remediation recommended"** issues → Can only be 🟡 MEDIUM or ⚪ LOW
   - **"Other"** / **"Advisory comments"** issues → Always ⚪ LOW (lowest priority)

2. **Qodo's position within each action level determines the specific severity:**
   - Group issues by action level ("Action required" vs "Review recommended" vs "Other")
   - Within "Action required" and "Review recommended" groups: earlier positions → higher severity, later positions → lower severity
   - Split point: roughly first half of each group gets the higher severity, second half gets the lower
   - All "Other" issues are treated as ⚪ LOW regardless of position

**Example:** 7 "Action required" issues would be split as:
- Issues 1-3: 🔴 CRITICAL
- Issues 4-7: 🟠 HIGH
- Result: No MEDIUM or LOW issues (because there are no "Review recommended" or "Other" issues)

**Example:** 5 "Action required" + 3 "Review recommended" + 2 "Other" issues would be split as:
- Issues 1-2 or 1-3: 🔴 CRITICAL (first ~half of "Action required")
- Issues 3-5 or 4-5: 🟠 HIGH (second ~half of "Action required")
- Issues 6-7: 🟡 MEDIUM (first ~half of "Review recommended")
- Issue 8: ⚪ LOW (second ~half of "Review recommended")
- Issues 9-10: ⚪ LOW (all "Other" issues)

**Action guidelines:**
- 🔴 CRITICAL / 🟠 HIGH ("Action required"): Always "Fix"
- 🟡 MEDIUM ("Review recommended"): Usually "Fix", can "Defer" if low impact
- ⚪ LOW ("Review recommended" or "Other"): Can be "Defer" unless quick to fix; "Other" issues are lowest priority

#### Output format

Display as a markdown table in Qodo's exact original ordering (do NOT reorder by severity - Qodo's order IS the severity ranking):

```
Qodo Issues for PR #123: [PR Title]

| # | Severity | Issue Title | Issue Details | Type | Action |
|---|----------|-------------|---------------|------|--------|
| 1 | 🔴 CRITICAL | Insecure authentication check | • **Location:** src/auth/service.py:42<br><br>• **Issue:** Authorization logic is inverted | 🐞 Bug ⛨ Security | Fix |
| 2 | 🔴 CRITICAL | Missing input validation | • **Location:** src/api/handlers.py:156<br><br>• **Issue:** User input not sanitized before database query | 📘 Rule violation ⛯ Reliability | Fix |
| 3 | 🟠 HIGH | Database query not awaited | • **Location:** src/db/repository.py:89<br><br>• **Issue:** Async call missing await keyword | 🐞 Bug ✓ Correctness | Fix |
```

### Step 5: Ask user for fix preference

After displaying the table, ask the user how they want to proceed using AskUserQuestion:

**Options:**
- 🔍 "Review each issue" - Review and approve/defer each issue individually (recommended for careful review)
- ⚡ "Auto-fix all" - Automatically apply all fixes marked as "Fix" without individual approval (faster, but less control)
- ❌ "Cancel" - Exit without making changes

**Based on the user's choice:**
- If "Review each issue": Proceed to Step 6 (manual review)
- If "Auto-fix all": Skip to Step 7 (auto-fix mode - apply all "Fix" issues automatically using Qodo's agent prompts)
- If "Cancel": Exit the skill

### Step 6: Review and fix issues (manual mode)

If "Review each issue" was selected:

- For each issue marked as "Fix" (starting with CRITICAL):
  - Read the relevant file(s) to understand the current code
  - Implement the fix by **executing the Qodo agent prompt as a direct instruction**. The agent prompt is the fix specification — follow it literally, do not reinterpret or improvise a different solution. Only deviate if the prompt is clearly outdated relative to the current code (e.g. references lines that no longer exist).
  - Calculate the proposed fix in memory (DO NOT use Edit or Write tool yet)
  - **Present the fix and ask for approval in a SINGLE step:**
    1. Show a brief header with issue title and location
    2. **Show Qodo's agent prompt in full** so the user can verify the fix matches it
    3. Display current code snippet
    4. Display proposed change as markdown diff
    5. Immediately use AskUserQuestion with these options:
       - ✅ "Apply fix" - Apply the proposed change
       - ⏭️ "Defer" - Skip this issue (will prompt for reason)
       - 🔧 "Modify" - User wants to adjust the fix first
  - **WAIT for user's choice via AskUserQuestion**
  - **If "Apply fix" selected:**
    - Apply change using Edit tool (or Write if creating new file)
    - Reply to the Qodo inline comment with the decision (see Step 8 for inline reply commands)
    - Git commit the fix: `git add <modified-files> && git commit -m "fix: <issue title>"`
    - Confirm: "✅ Fix applied, commented, and committed!"
    - Mark issue as completed
  - **If "Defer" selected:**
    - Ask for deferral reason using AskUserQuestion
    - Reply to the Qodo inline comment with the deferral (see Step 8 for inline reply commands)
    - Record reason and move to next issue
  - **If "Modify" selected:**
    - Inform user they can make changes manually
    - Move to next issue
- Continue until all "Fix" issues are addressed or the user decides to stop

#### Important notes

**Single-step approval with AskUserQuestion:**
- NO native Edit UI (no persistent permissions possible)
- Each fix requires explicit approval via custom question
- Clearer options, no risk of accidental auto-approval

**CRITICAL:** Single validation only - do NOT show the diff separately and then ask. Combine the diff display and the question into ONE message. The user should see: brief context → current code → proposed diff → AskUserQuestion, all at once.

**Example:** Show location, Qodo's guidance, current code, proposed diff, then AskUserQuestion with options (✅ Apply fix / ⏭️ Defer / 🔧 Modify). Wait for user choice, apply via Edit tool if approved.

### Step 7: Auto-fix mode

If "Auto-fix all" was selected:

- For each issue marked as "Fix" (starting with CRITICAL):
  - Read the relevant file(s) to understand the current code
  - Implement the fix by **executing the Qodo agent prompt as a direct instruction**. The agent prompt is the fix specification — follow it literally, do not reinterpret or improvise a different solution. Only deviate if the prompt is clearly outdated relative to the current code (e.g. references lines that no longer exist).
  - Apply the fix using Edit tool
  - Reply to the Qodo inline comment with the decision (see Step 8 for inline reply commands)
  - Git commit the fix: `git add <modified-files> && git commit -m "fix: <issue title>"`
  - Report each fix with the agent prompt that was followed:
    > ✅ **Fixed: [Issue Title]** at `[Location]`
    > **Agent prompt:** [the Qodo agent prompt used]
  - Mark issue as completed
- After all auto-fixes are applied, display summary:
  - List of all issues that were fixed
  - List of any issues that were skipped (with reasons)

### Step 8: Post summary to PR/MR

**REQUIRED:** After all issues have been reviewed (fixed or deferred), ALWAYS post a comment summarizing the actions taken, even if all issues were deferred.

See [providers.md § Post Summary Comment](./resources/providers.md#post-summary-comment) for provider-specific commands and summary format.

**After posting the summary, resolve the Qodo review comment:**

Find the Qodo "Code Review by Qodo" comment and mark it as resolved or react to acknowledge it.

See [providers.md § Resolve Qodo Review Comment](./resources/providers.md#resolve-qodo-review-comment) for provider-specific commands.

If resolve fails (comment not found, API error), continue — the summary comment is the important part.

### Step 9: Push to remote

If any fixes were applied (commits were created in Steps 6/7), ask the user if they want to push:
- If yes: `git push`
- If no: Inform them they can push later with `git push`

**Important:** If all issues were deferred, there are no commits to push — skip this step.

### Special cases

#### Unsupported git provider

If the remote URL doesn't match GitHub, GitLab, Bitbucket, or Azure DevOps, inform the user and exit.

See [providers.md § Error Handling](./resources/providers.md#error-handling) for details.

#### No PR/MR exists

- Inform: "No PR/MR found for branch `<branch-name>`"
- Ask: "Would you like me to create a PR/MR?"
- If yes: Use appropriate CLI to create PR/MR (see [providers.md § Create PR/MR](./resources/providers.md#create-prmr-special-case)), then inform "PR created! Qodo will review it shortly. Run this skill again in ~5 minutes."
- If no: Exit skill

**IMPORTANT:** Do NOT proceed without a PR/MR

#### No Qodo review yet

- Check if PR/MR has comments from Qodo bots (pr-agent-pro, qodo-merge[bot], etc.)
- If no Qodo comments found: Inform "Qodo hasn't reviewed this PR/MR yet. Please wait a few minutes for Qodo to analyze it."
- Exit skill (do NOT attempt manual review)

**IMPORTANT:** This skill only works with Qodo reviews, not manual reviews

#### Review in progress

If "Come back again in a few minutes" message is found, inform user to wait and try again, then exit.

#### Missing CLI tool

If the detected provider's CLI is not installed, provide installation instructions and exit.

See [providers.md § Error Handling](./resources/providers.md#error-handling) for provider-specific installation commands.

#### Inline reply commands

Used per-issue in Steps 6 and 7 to reply to Qodo's inline comments:

Use the inline comment ID preserved during deduplication (Step 3b) to reply directly to Qodo's comment.

See [providers.md § Reply to Inline Comments](./resources/providers.md#reply-to-inline-comments) for provider-specific commands and reply format.

Keep replies short (one line). If a reply fails, log it and continue.
