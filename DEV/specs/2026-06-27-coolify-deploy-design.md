# Deploy do NanoClaw no Coolify — Design / Spec

- **Data:** 2026-06-27
- **Status:** Aprovado (design) — aguardando revisão do spec antes do plano de implementação
- **Escopo:** Rodar o NanoClaw num servidor gerenciado por Coolify, com canal Telegram e autenticação Claude via `ANTHROPIC_API_KEY`.
- **Decisão de runtime:** Opção A — Docker-in-Docker (DinD), container único privilegiado, deploy como recurso **Docker Compose** do Coolify.

---

## 1. Contexto e restrições

O NanoClaw é um processo host (Node.js) que, **por mensagem**, cria containers Docker de agente (Claude Agent SDK) com bind-mounts de paths do host:

- project root (`process.cwd()`) montado read-only em `/workspace/project`
- `groups/<grupo>/` montado read-write em `/workspace/group`
- `data/sessions/<grupo>/.claude` montado read-write
- `.env` é "sombreado" com `/dev/null` dentro do container (segredos nunca entram no agente)

Os segredos são injetados em runtime por um **credential proxy** HTTP (porta `3001`) que o host roda. Em Linux o proxy faz bind no IP do bridge `docker0`; os containers de agente alcançam o proxy via `host.docker.internal` (resolvido com `--add-host=host.docker.internal:host-gateway`).

Fontes de verdade de configuração:

- `src/env.ts` lê **o arquivo `.env`** em `process.cwd()` (deliberadamente NÃO usa `process.env`, para não vazar segredos aos processos filhos). Tanto `credential-proxy.ts` quanto `config.ts` dependem disso.
- O serviço (launchd/systemd) injeta apenas `ASSISTANT_NAME`, `HOME`, `PATH` no processo host.
- O canal Telegram (`grammy`) roda no **processo host** e lê `TELEGRAM_BOT_TOKEN` do mesmo `.env`.

Implicações para o Coolify:

1. O host precisa de um daemon Docker. DinD resolve a **consistência de bind-mount** (mesmo namespace de filesystem), evitando o problema de path-matching do `docker.sock` (DooD).
2. Precisamos **materializar `.env`** a partir das env vars/secrets injetados pelo Coolify, porque o código lê o arquivo, não `process.env`.
3. O canal Telegram **não está no core** — precisa ser mesclado (`skill/telegram`) antes do build da imagem.
4. O registro do chat do Telegram é um passo **interativo pós-deploy** (depende do bot online para obter o `chat ID`).

## 2. Arquitetura alvo

```
Servidor Coolify
└── container nanoclaw (privileged: true)
    ├── dockerd interno (DinD, storage em volume /var/lib/docker)
    │     └── nanoclaw-agent:latest  ──> containers de agente (Claude SDK + Chromium)
    ├── credential proxy :3001  (injeta ANTHROPIC_API_KEY via header x-api-key)
    └── node dist/index.js  ──> canal Telegram (grammy)  ──> stdout (logs Coolify)
```

Ordem de boot do container (entrypoint):
1. Materializa `.env` e `data/env/env` a partir das env vars do Coolify.
2. Sobe `dockerd` em background; espera `docker info` responder (timeout com falha clara).
3. Se `nanoclaw-agent:latest` não existir no daemon interno, roda `./container/build.sh`.
4. `exec node dist/index.js` (PID 1 efetivo → sinais e logs corretos no Coolify).

## 3. Artefatos a criar (no fork `zczDief/nanoclaw`)

| Arquivo | Conteúdo |
|---|---|
| `Dockerfile.host` | Base Node 22 + Docker Engine (`dockerd`, `docker` CLI) + `git`. `npm ci && npm run build`. `ENTRYPOINT` = entrypoint abaixo. Não builda a imagem do agente em build-time (precisa do dockerd em runtime). |
| `deploy/coolify/entrypoint.sh` | Passos de boot da seção 2. Idempotente. Falha barulhenta se `dockerd` não subir. |
| `docker-compose.coolify.yml` | Serviço único `nanoclaw`: `privileged: true`, `restart: unless-stopped`, `build: { dockerfile: Dockerfile.host }`, volumes da seção 4, env vars da seção 5. |
| `DEV/RUNBOOK-coolify.md` | Operação: registro de chat, ver logs, restart, rebuild da imagem do agente, troubleshooting. |

> **Telegram:** antes do build, mesclar o canal no fork:
> ```
> git remote add telegram https://github.com/qwibitai/nanoclaw-telegram.git
> git fetch telegram main
> git merge telegram/main   # resolver conflito de package-lock.json com --theirs se ocorrer
> ```
> Traz `src/channels/telegram.ts`, dep `grammy`, `import './telegram.js'` no barrel `src/channels/index.ts`, e `TELEGRAM_BOT_TOKEN` no `.env.example`.
> Validação: `npm install && npm run build && npx vitest run src/channels/telegram.test.ts`.

## 4. Persistência (volumes Coolify)

| Volume | Caminho no container | Motivo |
|---|---|---|
| `nanoclaw-store` | `/app/store` | SQLite `messages.db` (chats registrados, histórico) — **crítico** |
| `nanoclaw-groups` | `/app/groups` | memória por grupo (`groups/<grupo>/CLAUDE.md`) — **crítico** |
| `nanoclaw-data` | `/app/data` | sessions do Claude (`data/sessions/`) + `data/env` |
| `nanoclaw-docker` | `/var/lib/docker` | cache do dockerd interno → evita rebuild da imagem do agente a cada restart |

`/app` é o WORKDIR e `process.cwd()` do processo host. `.env` materializado fica em `/app/.env` (não versionado, recriado no boot a partir dos secrets).

## 5. Configuração / secrets (env vars do Coolify)

| Variável | Tipo | Uso |
|---|---|---|
| `ANTHROPIC_API_KEY` | secret | credential proxy → autentica os agentes Claude |
| `TELEGRAM_BOT_TOKEN` | secret | canal Telegram (host) + sync para `data/env/env` |
| `ASSISTANT_NAME` | config | nome do assistente / trigger `@<nome>` (ex.: `Andy`) |
| `TZ` | config | timezone para tarefas agendadas |

Nenhum desses é commitado. O entrypoint escreve `/app/.env` e `/app/data/env/env` a partir deles no boot.

## 6. Fluxo de deploy (executado por mim, com acesso ao Coolify)

1. **Preparar o fork:** criar artefatos da seção 3 + merge do Telegram (seção 3). Build/test local verdes. **Commit + push exigem confirmação explícita do usuário** (regra global do orquestrador).
2. **Coolify:** via API/token fornecido pelo usuário — criar recurso *Docker Compose* apontando para o repo/branch do fork; configurar env vars (seção 5) e volumes (seção 4); disparar deploy.
3. **Boot:** primeira subida builda a imagem do agente (lenta, ~minutos; Chromium incluso).
4. **Registro do chat (interativo):** usuário cria o bot no `@BotFather`, envia `/chatid` ao bot; com o `chat ID`, registrar o chat main no container:
   ```
   npx tsx setup/index.ts --step register -- \
     --jid "tg:<chat-id>" --name "<nome>" --folder "telegram_main" \
     --trigger "@<ASSISTANT_NAME>" --channel telegram --no-trigger-required --is-main
   ```
5. **Verificação:** mensagem de teste no Telegram → resposta do agente; conferir logs do container no Coolify.

## 7. Critérios de sucesso

- Container sobe no Coolify e permanece `healthy`/running após restart (sem rebuildar a imagem do agente graças ao volume `nanoclaw-docker`).
- `docker info` interno OK; `nanoclaw-agent:latest` presente.
- Bot Telegram conecta (`getMe` OK) e o chat main registrado responde a uma mensagem de teste.
- Dados persistem entre restarts (chat registrado continua registrado; memória do grupo preservada).

## 8. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| `privileged: true` (exigência do DinD) | Documentado; container isolado; alternativa DooD foi descartada por fragilidade de path. |
| 1ª subida lenta (build da imagem do agente) | Volume `nanoclaw-docker` persiste o cache; rebuilds só quando necessário. |
| Registro do chat é manual/interativo | Documentado no RUNBOOK; depende do bot online. |
| Requisitos de recurso (Chromium no agente) | Recomendado servidor com ≥2 GB RAM e ≥10 GB disco. |
| Segredos em arquivo `.env` materializado | Arquivo só dentro do container, em volume; nunca commitado; `.env` é sombreado nos agentes. |

## 9. Fora de escopo

- Outros canais (WhatsApp, Slack, Discord, Gmail).
- Autenticação via OAuth do Claude Code.
- Agent Swarm no Telegram (`/add-telegram-swarm`) — pode ser adicionado depois.
- Backups automatizados dos volumes (mencionar no RUNBOOK como recomendação manual).
