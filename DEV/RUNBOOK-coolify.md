# RUNBOOK — NanoClaw no Coolify

Arquitetura: container único privilegiado (Docker-in-Docker). O entrypoint materializa
`.env` a partir dos secrets do Coolify, sobe um `dockerd` interno, builda a imagem do
agente (`nanoclaw-agent:latest`) se ausente, e roda o processo nanoclaw. Os agentes
recebem credenciais via o credential proxy nativo (porta 3001); o token do Telegram fica
no `.env` e é usado pelo processo host.

## Deploy
Recurso Coolify do tipo **Docker Compose**, apontando para `zczDief/nanoclaw` branch
`deploy/coolify`, arquivo `docker-compose.coolify.yml`.

### Env vars (Coolify → Environment Variables)
| Var | Tipo | Exemplo |
|---|---|---|
| `ANTHROPIC_API_KEY` | secret | `sk-ant-...` |
| `TELEGRAM_BOT_TOKEN` | secret | `123456:ABC-...` |
| `ASSISTANT_NAME` | config | `Andy` |
| `TZ` | config | `America/Sao_Paulo` |

### Volumes (persistentes)
`nanoclaw-store` → `/app/store` · `nanoclaw-groups` → `/app/groups` ·
`nanoclaw-data` → `/app/data` · `nanoclaw-docker` → `/var/lib/docker`

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
- **Bot não responde:** conferir `getMe` (`curl .../getMe`), chat registrado no SQLite, token presente no `.env` (`docker exec <c> cat /app/.env`).
- **dockerd não sobe:** ver `/var/log/dockerd.log` no container; confirmar `privileged: true`; em kernel sem overlay2, setar a env `DOCKERD_FLAGS=--storage-driver=vfs`.
- **Agentes sem credenciais:** o credential proxy (porta 3001) precisa do `ANTHROPIC_API_KEY` no `.env`; conferir logs de boot do nanoclaw.
- **Build do agente lento/falha:** Chromium é pesado; garantir ≥2 GB RAM e ≥10 GB disco no servidor.

## Backup (recomendação manual)
Faça snapshot periódico dos volumes `nanoclaw-store` e `nanoclaw-groups` (dados e memória).
