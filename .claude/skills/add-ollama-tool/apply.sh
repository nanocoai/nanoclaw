#!/usr/bin/env bash
set -euo pipefail

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

if ! grep -q '^[[:space:]]*ollama:' container/agent-runner/src/index.ts; then
  awk '
    /^[[:space:]]*nanoclaw: \{/ { in_nanoclaw = 1 }
    in_nanoclaw && /^    },$/ && !added {
      print
      print "    ollama: {"
      print "      command: '\''bun'\'',"
      print "      args: ['\''run'\'', path.join(__dirname, '\''ollama-mcp-stdio.ts'\'')],"
      print "      env: {"
      print "        ...(process.env.OLLAMA_HOST ? { OLLAMA_HOST: process.env.OLLAMA_HOST } : {}),"
      print "        ...(process.env.OLLAMA_ADMIN_TOOLS ? { OLLAMA_ADMIN_TOOLS: process.env.OLLAMA_ADMIN_TOOLS } : {}),"
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

if ! grep -q "import { ollamaEnv } from './ollama-env.js';" src/container-runner.ts; then
  awk '
    { print }
    /} from '\''\.\/providers\/provider-container-registry\.js'\'';/ && !added {
      print "import { ollamaEnv } from '\''./ollama-env.js'\'';"
      added = 1
    }
    END { if (!added) exit 1 }
  ' src/container-runner.ts > "$tmp"
  cp "$tmp" src/container-runner.ts
fi

if ! grep -q '\.\.\.ollamaEnv(),' src/container-runner.ts; then
  awk '
    /    TZ: containerConfig\.timezone \?\? TIMEZONE,/ && !added {
      print
      print "    ...ollamaEnv(),"
      added = 1
      next
    }
    { print }
    END { if (!added) exit 1 }
  ' src/container-runner.ts > "$tmp"
  cp "$tmp" src/container-runner.ts
fi

if ! grep -q "line.includes('\[OLLAMA\]')" src/drivers/docker-driver.ts; then
  perl -pi -e '
    my $q = chr 39;
    if (/^      if \(line\.includes\(.*\[ATOMIC\].*\)\) \{$/) {
      chomp;
      s/\) \{$//;
      $_ .= " || line.includes(${q}[OLLAMA]${q})) {\n";
      $added = 1;
    } elsif (/^      log\.debug\(line, \{ container: this\.name \}\);$/) {
      $_ = "      if (line.includes(${q}[OLLAMA]${q})) {\n" .
        "        log.info(line, { container: this.name });\n" .
        "      } else {\n" .
        "        log.debug(line, { container: this.name });\n" .
        "      }\n";
      $added = 1;
    }
    END { exit 1 unless $added }
  ' src/drivers/docker-driver.ts
fi
