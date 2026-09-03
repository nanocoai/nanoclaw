# Repo Tokens

A GitHub Action that calculates the size of your codebase in terms of tokens and updates a badge in your README.

<p>
  <img src="examples/green.svg" alt="tokens 12.4k">&nbsp;
  <img src="examples/yellow-green.svg" alt="tokens 74.8k">&nbsp;
  <img src="examples/yellow.svg" alt="tokens 120k">&nbsp;
  <img src="examples/red.svg" alt="tokens 158k">
</p>

## Usage

```yaml
- uses: nanocoai/nanoclaw/repo-tokens@v1
  with:
    include: 'src/**/*.ts'
    exclude: 'src/**/*.test.ts'
```

This counts tokens using [tiktoken](https://github.com/openai/tiktoken) and writes the result between HTML comment markers in your README:

The badge color reflects what percentage of an LLMs context window the codebase fills (context window size is configurable, defaults to 1M which is the size of current Claude models). Green for under 30%, yellow-green for 30%-50%, yellow for 50%-70%, red for 70%+.

## Why

Small codebases were always a good thing. With coding agents, there's now a huge advantage to having a codebase small enough that an agent can hold the full thing in context.

This badge gives some indication of how easy it will be to work with an agent on the codebase, and will hopefully be a visual reminder to avoid bloat.

## Examples

Repos using repo-tokens:

| Repo | Badge |
|------|-------|
| [NanoClaw](https://github.com/nanocoai/NanoClaw) | ![tokens](https://raw.githubusercontent.com/nanocoai/NanoClaw/main/repo-tokens/badge.svg) |

### Full workflow example

```yaml
name: Update token count

on:
  push:
    branches: [main]
    paths: ['src/**']

permissions:
  contents: write

jobs:
  update-tokens:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - uses: nanocoai/nanoclaw/repo-tokens@v1
        id: tokens
        with:
          include: 'src/**/*.ts'
          exclude: 'src/**/*.test.ts'
          badge-path: '.github/badges/tokens.svg'

      - name: Commit if changed
        run: |
          git add README.md .github/badges/tokens.svg
          git diff --cached --quiet && exit 0
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git commit -m "docs: update token count to ${{ steps.tokens.outputs.badge }}"
          git push
```

### README setup

Add markers where you want the token count text to appear:

```html
<!-- token-count --><!-- /token-count -->
```

The action replaces everything between the markers with the token count.

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `include` | *required* | Glob patterns for files to count (space-separated) |
| `exclude` | `''` | Glob patterns to exclude (space-separated) |
| `context-window` | `1000000` | Context window size for percentage calculation |
| `readme` | `README.md` | Path to README file |
| `encoding` | `cl100k_base` | Tiktoken encoding name |
| `marker` | `token-count` | HTML comment marker name |
| `badge-path` | `''` | Path to write SVG badge (empty = no SVG) |

## Outputs

| Output | Description |
|--------|-------------|
| `tokens` | Total token count (e.g., `34940`) |
| `percentage` | Percentage of context window (e.g., `17`) |
| `badge` | The formatted text that was inserted (e.g., `34.9k tokens · 17% of context window`) |

## How it works

Composite GitHub Action. Installs tiktoken, runs ~60 lines of inline Python. Takes about 10 seconds.

The action counts tokens and updates the README but does not commit. Your workflow decides the git strategy.
