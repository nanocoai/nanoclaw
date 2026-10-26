#!/usr/bin/env python3
"""
PreToolUse hook: Validates agent-browser open calls.
Blocks: private IPs, localhost, loopback, non-http(s) schemes,
        cloud metadata endpoints.
Logs all approved navigations to /workspace/group/logs/browser-audit.log.
"""
import datetime
import json
import os
import re
import sys
from urllib.parse import urlparse

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

tool_name = data.get("tool_name", "")
tool_input = data.get("tool_input", {})

if tool_name != "Bash":
    sys.exit(0)

command = (tool_input.get("command") or "").strip()

if not command.startswith("agent-browser open "):
    sys.exit(0)

# Extract the URL (first token after "agent-browser open ")
rest = command[len("agent-browser open "):].strip().strip("\"'")
url = rest.split()[0] if rest.split() else rest


def block(reason: str) -> None:
    print(json.dumps({"decision": "block", "reason": reason}))
    sys.exit(0)


try:
    parsed = urlparse(url)
except Exception:
    sys.exit(0)

scheme = (parsed.scheme or "").lower()
hostname = (parsed.hostname or "").lower()

# 1. Block non-http(s) schemes (file://, ftp://, data://, javascript://, etc.)
if scheme and scheme not in ("http", "https"):
    block(
        f"Security block: scheme '{scheme}://' is not permitted. "
        "Only http/https allowed for agent-browser."
    )

# 2. Block loopback / localhost
BLOCKED_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"}
if hostname in BLOCKED_HOSTS:
    block(
        f"Security block: agent-browser access to '{hostname}' is blocked (loopback address)."
    )

# 3. Block private IP ranges (SSRF prevention)
PRIVATE_PATTERNS = [
    r"^10\.\d+\.\d+\.\d+$",
    r"^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$",
    r"^192\.168\.\d+\.\d+$",
    r"^169\.254\.\d+\.\d+$",   # link-local / AWS IMDS v1
    r"^100\.(6[4-9]|[7-9]\d|1([01]\d|2[0-7]))\.\d+\.\d+$",  # CGNAT
    r"^fc[0-9a-f]{2}:",        # IPv6 ULA
]
for pat in PRIVATE_PATTERNS:
    if re.match(pat, hostname):
        block(
            f"Security block: agent-browser access to private IP '{hostname}' blocked (SSRF prevention)."
        )

# 4. Block cloud metadata endpoints explicitly
METADATA_HOSTS = {
    "169.254.169.254",          # AWS / GCP / Azure IMDS
    "metadata.google.internal",
    "100.100.100.200",          # Alibaba Cloud
}
if hostname in METADATA_HOSTS:
    block(
        f"Security block: agent-browser access to cloud metadata endpoint '{hostname}' is blocked."
    )

# Approved — log the navigation
log_path = "/workspace/group/logs/browser-audit.log"
try:
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    with open(log_path, "a") as f:
        ts = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
        f.write(f"{ts}  {url}\n")
except Exception:
    pass  # Never fail on logging errors

sys.exit(0)
