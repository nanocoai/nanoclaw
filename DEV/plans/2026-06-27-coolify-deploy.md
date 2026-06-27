# Coolify Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rodar o NanoClaw num servidor Coolify, com canal Telegram e Claude autenticado via `ANTHROPIC_API_KEY`, usando Docker-in-Docker (DinD) num container privilegiado.

**Architecture:** Um único serviço Coolify (Docker Compose, `privileged: true`) com `dockerd` interno. O entrypoint materializa `.env` a partir dos secrets do Coolify, sobe o `dockerd`, builda `nanoclaw-agent:latest` se ausente, e roda `node dist/index.js`. O host cria containers de agente como filhos do dockerd interno → bind-mounts funcionam nativamente.

**Tech Stack:** Node 22 (Debian/glibc), Docker Engine (dockerd + CLI), TypeScript (`tsc` → `dist/`), grammy (Telegram), better-sqlite3, Coolify (Docker Compose resource).

## Global Constraints

- Base de imagem: Debian/glibc com Node 22 (`node:22`) — NÃO Alpine (better-sqlite3 nativo + paridade com o agente `node:22-slim`).
- `process.cwd()` do host = `/app` (WORKDIR). `.env` materializado em `/app/.env`, nunca commitado.
- O app **não** builda a imagem do agente em runtime — o entrypoint é responsável por isso.
- Segredos só via env vars do Coolify: `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `ASSISTANT_NAME`, `TZ`. Nunca commitados.
- Volumes persistentes obrigatórios: `/app/store`, `/app/groups`, `/app/data`, `/var/lib/docker`.
- Imagem do agente: tag exata `nanoclaw-agent:latest` (vem de `src/config.ts`).
- Credential proxy: porta `3001`, alcançado pelos agentes via `host.docker.internal:host-gateway`.
- Todo o trabalho acontece na branch `deploy/coolify` do fork `zczDief/nanoclaw`.
- **Gates de aprovação (regra global do orquestrador):** o PRIMEIRO commit e o PUSH para o fork exigem confirmação explícita do usuário. O deploy no Coolify (Task 7) exige que o usuário forneça URL + API token + secrets.

---

## Mapa de arquivos

- Create: `Dockerfile.host` — imagem do processo host (Node + Docker Engine).
- Create: `deploy/coolify/entrypoint.sh` — boot: materializa env, sobe dockerd, builda agente, roda node.
- Create: `docker-compose.coolify.yml` — serviço Coolify (privileged, volumes, env).
- Create: `.dockerignore` (se ausente) — evitar copiar `node_modules`, `dist`, `.git`, `data`, `store`, `groups` para o build da imagem host.
- Create: `DEV/RUNBOOK-coolify.md` — operação e troubleshooting.
- Modify (via merge): `src/channels/telegram.ts`, `src/channels/index.ts`, `package.json`, `.env.example` — trazidos pelo merge de `telegram/main`.

---

### Task 1: Branch + canal Telegram

**Files:**
- Branch: `deploy/coolify` (a partir de `main`)
- Modify (via merge): `src/channels/telegram.ts`, `src/channels/telegram.test.ts`, `src/channels/index.ts`, `package.json`, `package-lock.json`, `.env.example`

**Interfaces:**
- Produces: `TelegramChannel` auto-registrado via `registerChannel('telegram', ...)`; dep `grammy`; env `TELEGRAM_BOT_TOKEN`.

- [ ] **Step 1: Criar a branch de deploy**

```bash
git checkout main
git checkout -b deploy/coolify
```

- [ ] **Step 2: Adicionar remote do Telegram (se ausente)**

```bash
git remote get-url telegram 2>/dev/null || git remote add telegram https://github.com/qwibitai/nanoclaw-telegram.git
git fetch telegram main
```
Expected: fetch baixa a branch `telegram/main` sem erro.

- [ ] **Step 3: Mesclar o canal Telegram**

```bash
git merge telegram/main || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```
Expected: merge conclui. Se houver outros conflitos além de `package-lock.json`, parar e resolver lendo os arquivos (intenção: preservar o barrel `src/channels/index.ts` com `import './telegram.js'`).

- [ ] **Step 4: Instalar deps e verificar build**

```bash
npm install
npm run build
```
Expected: `tsc` compila sem erros; `src/channels/telegram.ts` existe.

- [ ] **Step 5: Rodar os testes do canal Telegram**

```bash
npx vitest run src/channels/telegram.test.ts
```
Expected: todos os testes PASS.

- [ ] **Step 6: Commit** *(GATE: primeira gravação — confirmar com o usuário antes)*

```bash
git add -A
git commit -m "chore(deploy): merge telegram channel onto coolify branch"
```

---

### Task 2: Dockerfile.host

**Files:**
- Create: `Dockerfile.host`
- Create: `.dockerignore` (se ausente)

**Interfaces:**
- Produces: imagem que contém o código buildado em `/app/dist`, `docker`/`dockerd` no PATH, e `ENTRYPOINT` apontando para `deploy/coolify/entrypoint.sh`.

- [ ] **Step 1: Criar `.dockerignore`**

```
node_modules
dist
.git
data
store
groups
logs
*.log
.env
```

- [ ] **Step 2: Criar `Dockerfile.host`**

```dockerfile
# NanoClaw host process image (Docker-in-Docker)
# Runs the orchestrator + an inner dockerd that hosts agent containers.
FROM node:22

# Install Docker Engine (dockerd + CLI) from Docker's official APT repo.
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       docker-ce docker-ce-cli containerd.io docker-buildx-plugin \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install node deps first for layer caching.
COPY package*.json ./
RUN npm ci

# Copy the rest of the source and build.
COPY . .
RUN npm run build

# Entrypoint handles dockerd startup + agent image build + node start.
COPY deploy/coolify/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

- [ ] **Step 3: Validar o Dockerfile estaticamente (NÃO buildar ainda)**

> O build completo NÃO roda nesta task: o `Dockerfile.host` faz `COPY deploy/coolify/entrypoint.sh`, que só é criado na Task 3. O build E2E acontece na Task 5, depois que entrypoint e compose existem.

```bash
command -v hadolint >/dev/null && hadolint Dockerfile.host || echo "hadolint ausente — validação estática manual; build E2E na Task 5"
```
Expected: sem erros de hadolint (ou aviso de ausência). Conferir visualmente que `FROM node:22`, instalação do docker-ce, `npm ci`, `npm run build` e `ENTRYPOINT` estão presentes.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile.host .dockerignore
git commit -m "feat(deploy): add host Dockerfile with Docker-in-Docker"
```

---

### Task 3: entrypoint.sh

**Files:**
- Create: `deploy/coolify/entrypoint.sh`

**Interfaces:**
- Consumes: env vars `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `ASSISTANT_NAME`, `TZ`.
- Produces: `/app/.env`, `/app/data/env/env`, daemon `dockerd` ativo, imagem `nanoclaw-agent:latest`, processo `node /app/dist/index.js` como PID final.

- [ ] **Step 1: Criar `deploy/coolify/entrypoint.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/app
cd "$APP_DIR"

# 1. Materialize .env from injected secrets (code reads the FILE, not process.env).
echo "[entrypoint] writing .env from environment"
{
  [ -n "${ANTHROPIC_API_KEY:-}" ] && echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}"
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && echo "TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}"
  [ -n "${ASSISTANT_NAME:-}" ] && echo "ASSISTANT_NAME=${ASSISTANT_NAME}"
} > "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

# Sync non-secret env for agent containers (per add-telegram skill convention).
mkdir -p "$APP_DIR/data/env"
cp "$APP_DIR/.env" "$APP_DIR/data/env/env"

# 2. Start the inner Docker daemon.
echo "[entrypoint] starting dockerd"
# overlay2 needs an overlayfs-capable backing FS; fall back to vfs if it fails.
dockerd --host=unix:///var/run/docker.sock >/var/log/dockerd.log 2>&1 &

echo "[entrypoint] waiting for dockerd"
for i in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then
    echo "[entrypoint] dockerd is up"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "[entrypoint] FATAL: dockerd did not become ready in 60s" >&2
    cat /var/log/dockerd.log >&2 || true
    exit 1
  fi
  sleep 1
done

# 3. Build the agent image if missing (app does NOT build it at runtime).
if ! docker image inspect nanoclaw-agent:latest >/dev/null 2>&1; then
  echo "[entrypoint] building nanoclaw-agent:latest (first boot, slow)"
  ./container/build.sh
else
  echo "[entrypoint] nanoclaw-agent:latest already present"
fi

# 4. Run the orchestrator as the final process (correct signal handling).
echo "[entrypoint] starting nanoclaw"
exec node "$APP_DIR/dist/index.js"
```

- [ ] **Step 2: Tornar executável**

```bash
chmod +x deploy/coolify/entrypoint.sh
```

- [ ] **Step 3: Lint do script (shellcheck se disponível)**

```bash
command -v shellcheck >/dev/null && shellcheck deploy/coolify/entrypoint.sh || echo "shellcheck ausente — pular"
```
Expected: sem erros (warnings de SC2086 aceitáveis). Verificação funcional real ocorre na Task 5.

- [ ] **Step 4: Commit**

```bash
git add deploy/coolify/entrypoint.sh
git commit -m "feat(deploy): add DinD entrypoint (env, dockerd, agent build, run)"
```

---

### Task 4: docker-compose.coolify.yml

**Files:**
- Create: `docker-compose.coolify.yml`

**Interfaces:**
- Consumes: `Dockerfile.host`, env vars do Coolify.
- Produces: definição do serviço `nanoclaw` para o recurso Docker Compose do Coolify.

- [ ] **Step 1: Criar `docker-compose.coolify.yml`**

```yaml
services:
  nanoclaw:
    build:
      context: .
      dockerfile: Dockerfile.host
    privileged: true
    restart: unless-stopped
    environment:
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN}
      ASSISTANT_NAME: ${ASSISTANT_NAME:-Andy}
      TZ: ${TZ:-America/Sao_Paulo}
    volumes:
      - nanoclaw-store:/app/store
      - nanoclaw-groups:/app/groups
      - nanoclaw-data:/app/data
      - nanoclaw-docker:/var/lib/docker

volumes:
  nanoclaw-store:
  nanoclaw-groups:
  nanoclaw-data:
  nanoclaw-docker:
```

- [ ] **Step 2: Validar o compose**

```bash
docker compose -f docker-compose.coolify.yml config >/dev/null && echo "compose OK"
```
Expected: imprime `compose OK` (avisos sobre env vars não setadas são aceitáveis localmente).

- [ ] **Step 3: Commit**

```bash
git add docker-compose.coolify.yml
git commit -m "feat(deploy): add Coolify docker-compose (privileged DinD + volumes)"
```

---

### Task 5: Verificação E2E local (smoke test)

**Files:** nenhum (verificação).

**Pré-requisito:** Docker local (Docker Desktop no macOS). Se indisponível, pular para a verificação real no Coolify (Task 7) e anotar que o smoke local foi omitido.

- [ ] **Step 1: Build da imagem host**

```bash
docker build -f Dockerfile.host -t nanoclaw-host:test .
```
Expected: build conclui sem erro.

- [ ] **Step 2: Subir o container privilegiado com secrets de teste**

```bash
docker run -d --name nanoclaw-smoke --privileged \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" \
  -e ASSISTANT_NAME="Andy" \
  -v nanoclaw-smoke-docker:/var/lib/docker \
  nanoclaw-host:test
```
Expected: container inicia. (Definir `ANTHROPIC_API_KEY`/`TELEGRAM_BOT_TOKEN` no shell antes.)

- [ ] **Step 3: Verificar dockerd e build da imagem do agente**

```bash
sleep 20 && docker logs nanoclaw-smoke 2>&1 | tail -40
docker exec nanoclaw-smoke docker image inspect nanoclaw-agent:latest >/dev/null && echo "agent image OK"
```
Expected: logs mostram "dockerd is up" e build da imagem do agente; `agent image OK`. (Primeiro build é lento — aumentar o sleep se necessário.)

- [ ] **Step 4: Verificar conexão do Telegram e boot do nanoclaw**

```bash
docker logs nanoclaw-smoke 2>&1 | grep -iE "starting nanoclaw|telegram|credential proxy|Database initialized"
docker exec nanoclaw-smoke sh -c 'curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe"'
```
Expected: nanoclaw inicia, proxy/DB ok; `getMe` retorna `"ok":true`.

- [ ] **Step 5: Limpar o smoke test**

```bash
docker rm -f nanoclaw-smoke && docker volume rm nanoclaw-smoke-docker
```

---

### Task 6: RUNBOOK de operação

**Files:**
- Create: `DEV/RUNBOOK-coolify.md`

- [ ] **Step 1: Criar `DEV/RUNBOOK-coolify.md`**

````markdown
# RUNBOOK — NanoClaw no Coolify

## Deploy
Recurso Coolify do tipo **Docker Compose**, apontando para `zczDief/nanoclaw` branch `deploy/coolify`, arquivo `docker-compose.coolify.yml`.

### Env vars (Coolify → Environment Variables)
| Var | Tipo | Exemplo |
|---|---|---|
| `ANTHROPIC_API_KEY` | secret | `sk-ant-...` |
| `TELEGRAM_BOT_TOKEN` | secret | `123456:ABC-...` |
| `ASSISTANT_NAME` | config | `Andy` |
| `TZ` | config | `America/Sao_Paulo` |

### Volumes (persistentes)
`nanoclaw-store` → `/app/store` · `nanoclaw-groups` → `/app/groups` · `nanoclaw-data` → `/app/data` · `nanoclaw-docker` → `/var/lib/docker`

## Primeiro registro do chat (interativo)
1. Crie o bot no `@BotFather` (`/newbot`), copie o token → `TELEGRAM_BOT_TOKEN`.
2. (Grupos) `@BotFather` → `/mybots` → seu bot → Bot Settings → Group Privacy → **Turn off**.
3. Com o container rodando, obtenha o `chat ID` enviando `/chatid` ao bot.
4. Registre o chat main (terminal do container no Coolify):
   ```bash
   npx tsx setup/index.ts --step register -- \
     --jid "tg:<chat-id>" --name "<nome>" --folder "telegram_main" \
     --trigger "@Andy" --channel telegram --no-trigger-required --is-main
   ```
5. Envie uma mensagem ao chat → o agente responde.

## Operação
- **Logs:** painel do Coolify (stdout do container).
- **Restart:** botão Restart do Coolify. A imagem do agente NÃO rebuilda (volume `nanoclaw-docker`).
- **Rebuild da imagem do agente:** `docker exec <container> sh -c 'cd /app && docker rmi -f nanoclaw-agent:latest && ./container/build.sh'`.
- **Inspecionar chats:** `docker exec <container> sqlite3 /app/store/messages.db "SELECT jid,name,folder FROM registered_groups"`.

## Troubleshooting
- **Bot não responde:** confirir `getMe` (`curl .../getMe`), chat registrado no SQLite, token presente no `.env` (`docker exec <c> cat /app/.env`).
- **dockerd não sobe:** ver `/var/log/dockerd.log` no container; confirmar `privileged: true`; em kernel sem overlay2, ajustar `dockerd --storage-driver=vfs` no entrypoint.
- **Build do agente lento/falha:** Chromium é pesado; garantir ≥2 GB RAM e ≥10 GB disco no servidor.

## Backup (recomendação manual)
Faça snapshot periódico dos volumes `nanoclaw-store` e `nanoclaw-groups` (dados e memória).
````

- [ ] **Step 2: Commit**

```bash
git add DEV/RUNBOOK-coolify.md
git commit -m "docs(deploy): add Coolify runbook"
```

---

### Task 7: Deploy no Coolify (interativo, requer acesso)

**Files:** nenhum (operação externa).

**Pré-requisito (GATE):** usuário fornece **Coolify base URL + API token** e confirma o **push** da branch `deploy/coolify` para `origin`. Secrets (`ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`) fornecidos de forma segura.

- [ ] **Step 1: Push da branch (GATE — confirmar)**

```bash
git push -u origin deploy/coolify
```

- [ ] **Step 2: Descobrir a API do Coolify**

Carregar a referência da API do Coolify (versão da instância do usuário) via WebFetch da doc oficial, e validar o token:
```bash
curl -s -H "Authorization: Bearer $COOLIFY_TOKEN" "$COOLIFY_URL/api/v1/teams" | head
```
Expected: resposta JSON autenticada (não 401).

- [ ] **Step 3: Criar o recurso Docker Compose**

Via API do Coolify: criar uma application do tipo `dockercompose` apontando para o repo/branch `deploy/coolify` e `docker-compose.coolify.yml`. (Endpoints exatos conforme a doc carregada no Step 2.)

- [ ] **Step 4: Configurar env vars e disparar deploy**

Setar `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `ASSISTANT_NAME`, `TZ` (secrets marcados como tal) e acionar o deploy via API.
Expected: build inicia; acompanhar logs até "starting nanoclaw".

- [ ] **Step 5: Registrar o chat e verificar (RUNBOOK §"Primeiro registro")**

Seguir os passos do RUNBOOK: obter `chat ID`, registrar o chat main, enviar mensagem de teste.
Expected: o agente responde no Telegram.

- [ ] **Step 6: Atualizar WORKLOG**

```bash
# Registrar em DEV/WORKLOG.md: o que mudou, por quê, como foi verificado, próximo contexto.
git add DEV/WORKLOG.md && git commit -m "docs: worklog coolify deploy"
```

---

## Self-Review (preenchido)

**Spec coverage:** runtime DinD (Tasks 2-5) · artefatos host/entrypoint/compose (Tasks 2-4) · Telegram merge (Task 1) · persistência/volumes (Task 4) · secrets/env (Task 3-4) · fluxo de deploy + registro interativo (Task 7 + RUNBOOK) · critérios de sucesso (Tasks 5,7) · riscos documentados (RUNBOOK). Sem lacunas.

**Placeholder scan:** sem TBD/TODO. Os endpoints exatos da API do Coolify (Task 7 Steps 3-4) dependem da versão da instância e são resolvidos carregando a doc oficial no Step 2 — explicitado, não é placeholder de código.

**Type/nome consistency:** tag `nanoclaw-agent:latest`, porta `3001`, paths `/app/{store,groups,data}` e `/var/lib/docker`, e `TELEGRAM_BOT_TOKEN`/`ANTHROPIC_API_KEY`/`ASSISTANT_NAME` consistentes entre Dockerfile, entrypoint, compose e RUNBOOK.
