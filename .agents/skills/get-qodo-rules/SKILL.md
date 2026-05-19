---
name: get-qodo-rules
description: "Loads org- and repo-level coding rules from Qodo before code tasks begin, ensuring all generation and modification follows team standards. Use before any code generation or modification task when rules are not already loaded. Invoke when user asks to write, edit, refactor, or review code, or when starting implementation planning."
version: 2.0.0
allowed-tools: ["Bash"]
triggers:
  - "get.?qodo.?rules"
  - "get.?rules"
  - "load.?qodo.?rules"
  - "load.?rules"
  - "fetch.?qodo.?rules"
  - "fetch.?rules"
  - "qodo.?rules"
  - "coding.?rules"
  - "code.?rules"
  - "before.?cod"
  - "start.?coding"
  - "write.?code"
  - "implement"
  - "create.*code"
  - "build.*feature"
  - "add.*feature"
  - "fix.*bug"
  - "refactor"
  - "modify.*code"
  - "update.*code"
---

# Get Qodo Rules Skill

## Description

Fetches repository-specific coding rules from the Qodo platform API before code generation or modification tasks. Rules include security requirements, coding standards, quality guidelines, and team conventions that must be applied during code generation.
**Use** before any code generation or modification task when rules are not already loaded. Invoke when user asks to write, edit, refactor, or review code, or when starting implementation planning.
**Skip** if "Qodo Rules Loaded" already appears in conversation context

---

## Workflow

### Step 1: Check if Rules Already Loaded

If rules are already loaded (look for "Qodo Rules Loaded" in recent messages), skip to step 6.

### Step 2: Verify working in a git repository

- Check that the current directory is inside a git repository. If not, inform the user that a git repository is required and exit gracefully.
- Extract the repository scope from the git `origin` remote URL. If no remote is found, exit silently. If the URL cannot be parsed, inform the user and exit gracefully.
- Detect module-level scope: if inside a `modules/*` subdirectory, use it as the query scope; otherwise use repository-wide scope.

See [repository scope detection](references/repository-scope.md) for details.

### Step 3: Verify Qodo Configuration

Check that the required Qodo configuration is present. The default location is `~/.qodo/config.json`.

- **API key**: Read from `~/.qodo/config.json` (`API_KEY` field). If not found, inform the user that an API key is required and provide setup instructions, then exit gracefully.
- **Environment name**: Read from `~/.qodo/config.json` (`ENVIRONMENT_NAME` field), with `QODO_ENVIRONMENT_NAME` environment variable taking precedence. If not found, inform the user that an API key is required and provide setup instructions, then exit gracefully.

### Step 4: Fetch Rules with Pagination

- Fetch all pages from the API (50 rules per page) until no more results are returned.
- On each page, handle HTTP errors and exit gracefully with a user-friendly message.
- Accumulate all rules across pages into a single list.
- Stop after 100 pages maximum (safety limit).
- If no rules are found after all pages, inform the user and exit gracefully.

See [pagination details](references/pagination.md) for the full algorithm and error handling.

### Step 5: Format and Output Rules

- Print the "📋 Qodo Rules Loaded" header with repository scope, scope context, and total rule count.
- Group rules by severity and print each non-empty group: ERROR, WARNING, RECOMMENDATION.
- Each rule is formatted as: `- **{name}** ({category}): {description}`
- End output with `---`.

See [output format details](references/output-format.md) for the exact format.

### Step 6: Apply Rules by Severity

| Severity | Enforcement | When Skipped |
|---|---|---|
| **ERROR** | Must comply, non-negotiable. Add comment documenting compliance (e.g., `# Following Qodo rule: No Hardcoded Credentials`) | Explain to user and ask for guidance |
| **WARNING** | Should comply by default | Briefly explain why in response |
| **RECOMMENDATION** | Consider when appropriate | No action needed |

### Step 7: Report

After code generation, inform the user about rule application:
- **ERROR rules applied**: List which rules were followed
- **WARNING rules skipped**: Explain why
- **No rules applicable**: Inform: "No Qodo rules were applicable to this code change"
- **RECOMMENDATION rules**: Mention only if they influenced a design decision

---

## How Scope Levels Work

Determines scope from git remote and working directory (see [Step 2](#step-2-verify-working-in-a-git-repository)):

**Scope Hierarchy**:
- **Universal** (`/`) - applies everywhere
- **Org Level** (`/org/`) - applies to organization
- **Repo Level** (`/org/repo/`) - applies to repository
- **Path Level** (`/org/repo/path/`) - applies to specific paths

---

## Configuration

See `~/.qodo/config.json` for API key setup. Set `QODO_ENVIRONMENT_NAME` env var or `ENVIRONMENT_NAME` in config to select environment.

---

## Common Mistakes

- **Re-running when rules are loaded** - Check for "Qodo Rules Loaded" in context first
- **Missing compliance comments on ERROR rules** - ERROR rules require a comment documenting compliance
- **Forgetting to report when no rules apply** - Always inform the user when no rules were applicable, so they know the rules system is active
- **Not in git repo** - Inform the user that a git repository is required and exit gracefully; do not attempt code generation
- **No API key** - Inform the user with setup instructions; set `QODO_API_KEY` or create `~/.qodo/config.json`
- **No rules found** - Inform the user; set up rules at app.qodo.ai
