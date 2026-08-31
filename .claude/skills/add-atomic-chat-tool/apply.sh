#!/usr/bin/env bash
set -euo pipefail

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

if ! grep -q '^[[:space:]]*atomic_chat:' container/agent-runner/src/index.ts; then
  awk '
    /^[[:space:]]*nanoclaw: \{/ { in_nanoclaw = 1 }
    in_nanoclaw && /^    },$/ && !added {
      print
      print "    atomic_chat: {"
      print "      command: '\''bun'\'',"
      print "      args: ['\''run'\'', path.join(__dirname, '\''atomic-chat-mcp-stdio.ts'\'')],"
      print "      env: {"
      print "        ...(process.env.ATOMIC_CHAT_HOST ? { ATOMIC_CHAT_HOST: process.env.ATOMIC_CHAT_HOST } : {}),"
      print "        ...(process.env.ATOMIC_CHAT_API_KEY ? { ATOMIC_CHAT_API_KEY: process.env.ATOMIC_CHAT_API_KEY } : {}),"
      print "      },"
      print "    },"
      added = 1
      in_nanoclaw = 0
      next
    }
    { print }
    END { if (!added) exit 1 }
  ' container/agent-runner/src/index.ts > "$tmp"
  cp "$tmp" container/agent-runner/src/index.ts
fi

if ! grep -q "import { atomicChatEnv } from './atomic-chat-env.js';" src/container-runner.ts; then
  awk '
    { print }
    /} from '\''\.\/providers\/provider-container-registry\.js'\'';/ && !added {
      print "import { atomicChatEnv } from '\''./atomic-chat-env.js'\'';"
      added = 1
    }
    END { if (!added) exit 1 }
  ' src/container-runner.ts > "$tmp"
  cp "$tmp" src/container-runner.ts
fi

if ! grep -q '\.\.\.atomicChatEnv(),' src/container-runner.ts; then
  awk '
    /    \.\.\.\(gateway\.env \?\? \{\}\),/ && !added {
      print
      print "    ...atomicChatEnv(),"
      added = 1
      next
    }
    { print }
    END { if (!added) exit 1 }
  ' src/container-runner.ts > "$tmp"
  cp "$tmp" src/container-runner.ts
fi

if ! grep -q "line.includes('\[ATOMIC\]')" src/drivers/docker-driver.ts; then
  perl -pi -e '
    my $q = chr 39;
    if (/^      if \(line\.includes\(.*\[OLLAMA\].*\)\) \{$/) {
      chomp;
      s/\) \{$//;
      $_ .= " || line.includes(${q}[ATOMIC]${q})) {\n";
      $added = 1;
    } elsif (/^      log\.debug\(line, \{ container: this\.name \}\);$/) {
      $_ = "      if (line.includes(${q}[ATOMIC]${q})) {\n" .
        "        log.info(line, { container: this.name });\n" .
        "      } else {\n" .
        "        log.debug(line, { container: this.name });\n" .
        "      }\n";
      $added = 1;
    }
    END { exit 1 unless $added }
  ' src/drivers/docker-driver.ts
fi
