#!/usr/bin/env python3
"""Regenerate repo-tokens/badge.svg for this repo.

Counts the committed tree at HEAD (never the working tree, so local
uncommitted files can't skew the number) with the same formatting and
color logic as action.yml. Run from the repo root:

    pip install tiktoken && python3 repo-tokens/recount.py
"""

import subprocess

import tiktoken

CONTEXT_WINDOW = 1_000_000
BADGE_PATH = "repo-tokens/badge.svg"
LINK_URL = "https://github.com/nanocoai/nanoclaw/tree/main/repo-tokens"


def included(path: str) -> bool:
    """The system-understanding surface: host + agent-runner source (tests
    excluded), the container build surface, the service definition, CLAUDE.md."""
    if path.endswith(".test.ts"):
        return False
    if path.startswith("src/") and path.endswith(".ts"):
        return True
    if path.startswith("container/agent-runner/src/") and path.endswith(".ts"):
        return True
    return path in (
        "container/Dockerfile",
        "container/build.sh",
        "launchd/com.nanoclaw.plist",
        "CLAUDE.md",
    )


def main() -> None:
    tracked = subprocess.run(
        ["git", "ls-tree", "-r", "--name-only", "HEAD"],
        capture_output=True, text=True, check=True,
    ).stdout.splitlines()
    files = [f for f in tracked if included(f)]

    enc = tiktoken.get_encoding("cl100k_base")
    total = 0
    for path in files:
        content = subprocess.run(
            ["git", "show", f"HEAD:{path}"],
            capture_output=True, text=True, errors="ignore", check=True,
        ).stdout
        total += len(enc.encode(content))

    if total >= 100000:
        display = f"{round(total / 1000)}k"
    elif total >= 1000:
        display = f"{total / 1000:.1f}k"
    else:
        display = str(total)
    pct = round(total / CONTEXT_WINDOW * 100)
    print(f"Files: {len(files)}, Tokens: {total}, Badge: {display} tokens · {pct}% of context window")

    label_text, value_text = "tokens", display
    full_desc = f"{display} tokens, {pct}% of context window"
    cw = 7.0
    label_w = round(len(label_text) * cw) + 10
    value_w = round(len(value_text) * cw) + 10
    total_w = label_w + value_w
    if pct < 30:
        color = "#4c1"
    elif pct < 50:
        color = "#97ca00"
    elif pct < 70:
        color = "#dfb317"
    else:
        color = "#e05d44"
    lx = label_w // 2
    vx = label_w + value_w // 2

    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{total_w}" height="20" role="img" aria-label="{full_desc}">
  <title>{full_desc}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="{total_w}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <a xlink:href="{LINK_URL}">
    <g clip-path="url(#r)">
      <rect width="{label_w}" height="20" fill="#555"/>
      <rect x="{label_w}" width="{value_w}" height="20" fill="{color}"/>
      <rect width="{total_w}" height="20" fill="url(#s)"/>
      <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
        <text aria-hidden="true" x="{lx}" y="15" fill="#010101" fill-opacity=".3">{label_text}</text>
        <text x="{lx}" y="14">{label_text}</text>
        <text aria-hidden="true" x="{vx}" y="15" fill="#010101" fill-opacity=".3">{value_text}</text>
        <text x="{vx}" y="14">{value_text}</text>
      </g>
    </g>
  </a>
</svg>'''
    with open(BADGE_PATH, "w", encoding="utf-8") as f:
        f.write(svg)
    print(f"Badge written to {BADGE_PATH}")


if __name__ == "__main__":
    main()
