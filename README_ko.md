<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  에이전트를 각자의 컨테이너에서 안전하게 실행하는 AI 어시스턴트입니다. 가볍고, 쉽게 이해할 수 있으며, 여러분의 필요에 맞게 완전히 커스터마이즈할 수 있도록 만들어졌습니다.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="https://docs.nanoclaw.dev">문서</a>&nbsp; • &nbsp;
  <a href="README.md">English</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="README_ja.md">日本語</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="repo tokens" valign="middle"></a>
</p>

---

## NanoClaw를 만든 이유

[OpenClaw](https://github.com/openclaw/openclaw)는 인상적인 프로젝트지만, 제가 이해하지 못하는 복잡한 소프트웨어에 제 삶 전체에 대한 접근 권한을 줬다면 저는 잠을 이루지 못했을 것입니다. OpenClaw는 거의 50만 줄에 달하는 코드, 53개의 설정 파일, 70개 이상의 의존성을 가지고 있습니다. 보안은 진정한 OS 수준의 격리가 아니라 애플리케이션 수준(허용 목록, 페어링 코드)에 의존합니다. 모든 것이 메모리를 공유하는 하나의 Node 프로세스에서 실행됩니다.

NanoClaw는 그와 동일한 핵심 기능을 제공하지만, 이해할 수 있을 만큼 작은 코드베이스로 구현합니다. 하나의 프로세스와 몇 개의 파일뿐입니다. Claude 에이전트는 단순한 권한 검사 뒤가 아니라, 파일시스템이 격리된 각자의 Linux 컨테이너에서 실행됩니다.

## 빠른 시작

```bash
git clone https://github.com/nanocoai/nanoclaw.git nanoclaw-v2
cd nanoclaw-v2
bash nanoclaw.sh
```

`nanoclaw.sh`는 갓 준비한 머신에서 시작해 메시지를 보낼 수 있는 이름 붙은 에이전트까지 안내합니다. 누락된 경우 Node, pnpm, Docker를 설치하고, Anthropic 자격 증명을 OneCLI에 등록하며, 에이전트 컨테이너를 빌드하고, 첫 채널(Telegram, Discord, WhatsApp 또는 로컬 CLI)을 페어링합니다. 어떤 단계가 실패하면 Claude Code가 자동으로 호출되어 원인을 진단하고 중단된 지점부터 재개합니다.

<details>
<summary><strong>NanoClaw v1에서 마이그레이션하시나요?</strong></summary>

기존 v1 설치 옆에 새로운 v2 체크아웃을 만들어 실행하세요:

```bash
git clone https://github.com/nanocoai/nanoclaw.git nanoclaw-v2
cd nanoclaw-v2
bash migrate-v2.sh
```

`migrate-v2.sh`는 v1 설치(형제 디렉터리, 또는 `NANOCLAW_V1_PATH=/path/to/nanoclaw`)를 찾아 상태를 v2 체크아웃으로 마이그레이션한 다음, 판단이 필요한 부분(소유자 시딩, 공유 메모리 마이그레이션, 포크 커스터마이징 재적용)을 마무리하기 위해 Claude Code로 `exec`합니다.

이 스크립트는 Claude 세션 내부가 아니라 직접 실행하세요. 결정론적인 부분에서 Node/pnpm 부트스트랩, Docker, OneCLI, 컨테이너 빌드를 위해 대화형 프롬프트와 실제 셸 I/O가 필요합니다.

**무엇을 하는가:** `.env`를 병합하고, `registered_groups`로부터 v2 DB를 시딩하며, 그룹 폴더 + 세션 데이터 + 예약 작업을 복사하고, 선택한 채널 어댑터를 설치하며, 채널 인증 상태(WhatsApp의 Baileys 키스토어 + LID 매핑 포함)를 복사하고, 에이전트 컨테이너를 빌드합니다.

**무엇을 하지 않는가:** 시스템 서비스를 전환하지 않습니다. 프롬프트에서 *"switch to v2"*를 선택하거나, 테스트 후 수동으로 전환하세요. 기존 v1 설치는 그대로 유지됩니다.

무엇이 달라졌는지는 [docs/v1-to-v2-changes.md](docs/v1-to-v2-changes.md)를, 개발 노트는 [docs/migration-dev.md](docs/migration-dev.md)를 참고하세요.

</details>

## 철학

**이해할 수 있을 만큼 작게.** 하나의 프로세스, 몇 개의 소스 파일, 마이크로서비스 없음. NanoClaw 코드베이스 전체를 이해하고 싶다면 Claude Code에게 안내해 달라고 요청하기만 하면 됩니다.

**격리를 통한 보안.** 에이전트는 Linux 컨테이너에서 실행되며 명시적으로 마운트된 것만 볼 수 있습니다. 명령이 호스트가 아니라 컨테이너 안에서 실행되기 때문에 Bash 접근도 안전합니다.

**개별 사용자를 위해 설계.** NanoClaw는 거대한 단일 프레임워크가 아니라, 각 사용자의 정확한 필요에 맞는 소프트웨어입니다. 비대한 소프트웨어가 되는 대신, NanoClaw는 맞춤형이 되도록 설계되었습니다. 직접 포크를 만들고 Claude Code가 여러분의 필요에 맞게 수정하도록 합니다.

**커스터마이징 = 코드 변경.** 설정의 난립이 없습니다. 다른 동작을 원하시나요? 코드를 수정하세요. 코드베이스가 충분히 작아서 안전하게 변경할 수 있습니다.

**AI 네이티브, 설계상 하이브리드.** 설치와 온보딩 흐름은 최적화된 스크립트 경로로, 빠르고 결정론적입니다. 어떤 단계에 판단이 필요할 때 — 설치 실패, 안내가 필요한 결정, 커스터마이징 등 — 제어권이 Claude Code로 매끄럽게 넘어갑니다. 설정 이후에도 모니터링 대시보드나 디버깅 UI가 없습니다. 채팅으로 문제를 설명하면 Claude Code가 처리합니다.

**기능보다 스킬.** 트렁크는 특정 채널 어댑터나 대체 에이전트 프로바이더가 아니라 레지스트리와 인프라를 제공합니다. 채널(Discord, Slack, Telegram, WhatsApp, …)은 오래 유지되는 `channels` 브랜치에, 대체 프로바이더(OpenCode, Ollama)는 `providers` 브랜치에 있습니다. `/add-telegram`, `/add-opencode` 등을 실행하면 스킬이 여러분이 필요로 하는 모듈만 정확히 포크로 복사합니다. 요청하지 않은 기능은 없습니다.

**최고의 하니스, 최고의 모델.** NanoClaw는 Anthropic의 공식 Claude Agent SDK를 통해 Claude Code를 네이티브로 사용하므로, 최신 Claude 모델과 Claude Code의 전체 도구 세트를 누릴 수 있습니다. 여기에는 자신의 NanoClaw 포크를 직접 수정하고 확장하는 능력도 포함됩니다. 다른 프로바이더는 드롭인 옵션입니다. OpenAI의 Codex는 `/add-codex`(ChatGPT 구독 또는 API 키), OpenRouter·Google·DeepSeek 등은 OpenCode를 통한 `/add-opencode`, 로컬 오픈 웨이트 모델은 `/add-ollama-provider`로 추가합니다. 프로바이더는 에이전트 그룹별로 설정할 수 있습니다.

## 지원 기능

- **멀티 채널 메시징** — WhatsApp, Telegram, Discord, Slack, Microsoft Teams, iMessage, Matrix, Google Chat, Webex, Linear, GitHub, WeChat, 그리고 Resend를 통한 이메일. `/add-<channel>` 스킬로 필요할 때 설치합니다. 하나 또는 여러 개를 동시에 실행할 수 있습니다.
- **유연한 격리** — 완전한 프라이버시를 위해 각 채널을 자체 에이전트에 연결하거나, 대화는 분리하되 메모리는 통합하기 위해 하나의 에이전트를 여러 채널에서 공유하거나, 여러 채널을 하나의 공유 세션으로 묶어 하나의 대화가 여러 채널에 걸쳐 이어지도록 할 수 있습니다. `/manage-channels`로 채널별로 선택하세요. [docs/isolation-model.md](docs/isolation-model.md)를 참고하세요.
- **에이전트별 작업 공간** — 각 에이전트 그룹은 자체 `CLAUDE.md`, 자체 메모리, 자체 컨테이너, 그리고 여러분이 허용한 마운트만 갖습니다. 직접 연결하지 않는 한 경계를 넘는 것은 아무것도 없습니다.
- **예약 작업** — Claude를 실행하고 여러분에게 다시 메시지를 보낼 수 있는 반복 작업
- **웹 접근** — 웹에서 검색하고 콘텐츠를 가져오기
- **컨테이너 격리** — 에이전트는 Docker(macOS/Linux/WSL2)에서 샌드박스화되며, 선택적으로 [Docker Sandboxes](docs/docker-sandboxes.md) 마이크로 VM 격리나 macOS 네이티브 런타임인 Apple Container를 사용할 수 있습니다
- **자격 증명 보안** — 에이전트는 원시 API 키를 절대 보유하지 않습니다. 아웃바운드 요청은 [OneCLI의 Agent Vault](https://github.com/onecli/onecli)를 통해 라우팅되며, 요청 시점에 자격 증명을 주입하고 에이전트별 정책과 속도 제한을 적용합니다.

## 사용법

트리거 단어(기본값: `@Andy`)로 어시스턴트에게 말을 거세요:

```
@Andy 매주 평일 오전 9시에 영업 파이프라인 개요를 보내줘 (내 Obsidian 보관함 폴더에 접근 가능)
@Andy 매주 금요일에 지난 한 주간의 git 히스토리를 검토하고, 내용이 어긋나면 README를 업데이트해줘
@Andy 매주 월요일 오전 8시에 Hacker News와 TechCrunch에서 AI 관련 소식을 모아 브리핑을 보내줘
```

여러분이 소유하거나 관리하는 채널에서는 그룹과 작업을 관리할 수 있습니다:
```
@Andy 모든 그룹에 걸친 예약 작업을 전부 나열해줘
@Andy 월요일 브리핑 작업을 일시 정지해줘
@Andy Family Chat 그룹에 참여해줘
```

## 커스터마이징

NanoClaw는 설정 파일을 사용하지 않습니다. 변경하려면 Claude Code에게 원하는 것을 말하기만 하면 됩니다:

- "트리거 단어를 @Bob으로 바꿔줘"
- "앞으로는 응답을 더 짧고 직접적으로 하도록 기억해줘"
- "내가 좋은 아침이라고 인사하면 맞춤 인사를 추가해줘"
- "매주 대화 요약을 저장해줘"

또는 안내형 변경을 위해 `/customize`를 실행하세요.

코드베이스가 충분히 작아서 Claude가 안전하게 수정할 수 있습니다.

## 기여하기

**기능을 추가하지 마세요. 스킬을 추가하세요.**

새로운 채널이나 에이전트 프로바이더를 추가하고 싶다면 트렁크에 추가하지 마세요. 새 채널 어댑터는 `channels` 브랜치에, 새 에이전트 프로바이더는 `providers` 브랜치에 들어갑니다. 사용자는 `/add-<name>` 스킬로 자신의 포크에 설치하며, 이 스킬은 관련 모듈을 표준 경로로 복사하고, 등록을 연결하며, 의존성을 고정합니다.

이를 통해 트렁크는 순수한 레지스트리이자 인프라로 유지되고, 모든 포크는 가벼운 상태를 유지합니다. 사용자는 요청한 채널과 프로바이더만 얻고 그 외에는 아무것도 얻지 않습니다.

### RFS (Request for Skills)

저희가 보고 싶은 스킬:

**커뮤니케이션 채널**
- `/add-signal` — Signal을 채널로 추가

## 요구 사항

- macOS 또는 Linux (Windows는 WSL2 경유)
- Node.js 20+ 및 pnpm 10+ (설치 프로그램이 누락 시 둘 다 설치합니다)
- [Docker Desktop](https://docker.com/products/docker-desktop) (macOS/Windows) 또는 Docker Engine (Linux)
- `/customize`, `/debug`, 설정 중 오류 복구, 그리고 모든 `/add-<channel>` 스킬을 위한 [Claude Code](https://claude.ai/download)

## 아키텍처

```
메시징 앱 → 호스트 프로세스(라우터) → inbound.db → 컨테이너(Bun, Claude Agent SDK) → outbound.db → 호스트 프로세스(전송) → 메시징 앱
```

하나의 Node 호스트가 세션별 에이전트 컨테이너를 오케스트레이션합니다. 메시지가 도착하면 호스트는 엔티티 모델(사용자 → 메시징 그룹 → 에이전트 그룹 → 세션)을 통해 라우팅하고, 세션의 `inbound.db`에 기록한 뒤 컨테이너를 깨웁니다. 컨테이너 내부의 에이전트 러너는 `inbound.db`를 폴링하고, Claude를 실행하며, 응답을 `outbound.db`에 기록합니다. 호스트는 `outbound.db`를 폴링하여 채널 어댑터를 통해 다시 전송합니다.

세션당 두 개의 SQLite 파일이 있으며 각각 정확히 하나의 작성자만 갖습니다. 교차 마운트 경합이 없고, IPC가 없으며, stdin 파이핑이 없습니다. 채널과 대체 프로바이더는 시작 시 자체 등록됩니다. 트렁크는 레지스트리와 Chat SDK 브리지를 제공하고, 어댑터 자체는 포크별로 스킬을 통해 설치됩니다.

전체 아키텍처 설명은 [docs/architecture.md](docs/architecture.md)를, 3단계 격리 모델은 [docs/isolation-model.md](docs/isolation-model.md)를 참고하세요.

핵심 파일:
- `src/index.ts` — 진입점: DB 초기화, 채널 어댑터, 전송 폴링, 스윕
- `src/router.ts` — 인바운드 라우팅: 메시징 그룹 → 에이전트 그룹 → 세션 → `inbound.db`
- `src/delivery.ts` — `outbound.db` 폴링, 어댑터를 통한 전송, 시스템 액션 처리
- `src/host-sweep.ts` — 60초 스윕: 정체 감지, 예정 메시지 깨우기, 반복 처리
- `src/session-manager.ts` — 세션 확인, `inbound.db` / `outbound.db` 열기
- `src/container-runner.ts` — 에이전트 그룹별 컨테이너 생성, OneCLI 자격 증명 주입
- `src/db/` — 중앙 DB (사용자, 역할, 에이전트 그룹, 메시징 그룹, 연결, 마이그레이션)
- `src/channels/` — 채널 어댑터 인프라 (어댑터는 `/add-<channel>` 스킬로 설치)
- `src/providers/` — 호스트 측 프로바이더 설정 (`claude`는 기본 내장, 그 외는 스킬 경유)
- `container/agent-runner/` — Bun 에이전트 러너: 폴 루프, MCP 도구, 프로바이더 추상화
- `groups/<folder>/` — 에이전트 그룹별 파일시스템 (`CLAUDE.md`, 스킬, 컨테이너 설정)

## FAQ

**왜 Docker인가요?**

Docker는 크로스 플랫폼 지원(macOS, Linux, 그리고 WSL2 경유 Windows)과 성숙한 생태계를 제공합니다. macOS에서는 더 가벼운 네이티브 런타임인 Apple Container도 지원됩니다. 추가 격리를 위해 [Docker Sandboxes](docs/docker-sandboxes.md)는 각 컨테이너를 마이크로 VM 안에서 실행합니다.

**Linux나 Windows에서 실행할 수 있나요?**

네. Docker가 기본 런타임이며 macOS, Linux, Windows(WSL2 경유)에서 작동합니다. `bash nanoclaw.sh`를 실행하기만 하면 됩니다.

**이것은 안전한가요?**

에이전트는 애플리케이션 수준의 권한 검사 뒤가 아니라 컨테이너에서 실행됩니다. 명시적으로 마운트된 디렉터리만 접근할 수 있습니다. 자격 증명은 컨테이너에 들어가지 않습니다. 아웃바운드 API 요청은 [OneCLI의 Agent Vault](https://github.com/onecli/onecli)를 통해 라우팅되며, 프록시 수준에서 인증을 주입하고 속도 제한과 접근 정책을 지원합니다. 여전히 실행하는 것을 검토해야 하지만, 코드베이스가 충분히 작아서 실제로 검토할 수 있습니다. 전체 보안 모델은 [보안 문서](https://docs.nanoclaw.dev/concepts/security)를 참고하세요.

**왜 설정 파일이 없나요?**

설정의 난립을 원하지 않습니다. 모든 사용자는 일반적인 시스템을 설정하는 대신, 코드가 정확히 원하는 대로 동작하도록 NanoClaw를 커스터마이즈해야 합니다. 설정 파일을 선호한다면 Claude에게 추가해 달라고 할 수 있습니다.

**서드파티나 오픈소스 모델을 사용할 수 있나요?**

네. 지원되는 경로는 `/add-opencode`(OpenCode 설정을 통한 OpenRouter, OpenAI, Google, DeepSeek 등) 또는 `/add-ollama-provider`(Ollama를 통한 로컬 오픈 웨이트 모델)입니다. 둘 다 에이전트 그룹별로 설정할 수 있으므로, 같은 설치 내에서 서로 다른 에이전트가 서로 다른 백엔드에서 실행될 수 있습니다.

일회성 실험의 경우, Claude API 호환 엔드포인트라면 `.env`를 통해서도 작동합니다:

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

**문제를 어떻게 디버깅하나요?**

Claude Code에게 물어보세요. "스케줄러가 왜 실행되지 않지?" "최근 로그에 뭐가 있지?" "이 메시지는 왜 응답을 받지 못했지?" 그것이 NanoClaw의 바탕에 깔린 AI 네이티브 접근 방식입니다.

**설정이 왜 작동하지 않나요?**

어떤 단계가 실패하면 `nanoclaw.sh`는 진단하고 재개하기 위해 Claude Code로 넘깁니다. 그래도 해결되지 않으면 `claude`를 실행한 뒤 `/debug`를 실행하세요. Claude가 다른 사용자에게도 영향을 줄 만한 문제를 발견하면, 관련 설정 단계나 스킬에 대한 PR을 열어주세요.

**NanoClaw를 어떻게 제거하나요?**

```bash
bash nanoclaw.sh --uninstall
```

모든 설치는 체크아웃별 ID로 태깅되므로, 제거 프로그램은 해당 사본에 속한 것만 제거합니다: 백그라운드 서비스, 컨테이너와 이미지, 앱 데이터와 로그, 에이전트 파일, 그리고 이 사본의 OneCLI 볼트 에이전트입니다. 공유되는 것 — OneCLI 앱과 여러분의 자격 증명, 머신의 다른 NanoClaw 사본 — 은 그대로 둡니다. 무엇을 발견했는지 정확히 보여주고 그룹별로 확인을 요청합니다. 여러분이 동의하기 전까지는 아무것도 삭제되지 않습니다. 변경 없이 미리 보려면 `--dry-run`을, 프롬프트를 건너뛰려면 `--yes`를 사용하세요. `.env`는 제거 전에 백업됩니다. 마무리하려면 체크아웃 폴더 자체를 삭제하세요.

**어떤 변경이 코드베이스에 받아들여지나요?**

기본 구성에는 보안 수정, 버그 수정, 명확한 개선만 받아들여집니다. 그게 전부입니다.

그 외의 모든 것(새로운 기능, OS 호환성, 하드웨어 지원, 향상)은 스킬로 기여해야 합니다. 채널과 프로바이더 코드는 `channels`/`providers` 레지스트리 브랜치에, 그 외에는 자체 완결형 스킬로 기여합니다. [docs/customizing.md](docs/customizing.md)와 [CONTRIBUTING.md](CONTRIBUTING.md)를 참고하세요.

이를 통해 기본 시스템을 최소한으로 유지하고, 모든 사용자가 원하지 않는 기능을 떠안지 않으면서 자신의 설치를 커스터마이즈할 수 있습니다.

## 커뮤니티

질문이 있나요? 아이디어가 있나요? [Discord에 참여하세요](https://discord.gg/VDdww8qS42).

## 변경 이력

호환성을 깨는 변경 사항은 [CHANGELOG.md](CHANGELOG.md)를, 또는 문서 사이트의 [전체 릴리스 히스토리](https://docs.nanoclaw.dev/changelog)를 참고하세요.

## 라이선스

MIT

<img referrerpolicy="no-referrer-when-downgrade" src="https://static.scarf.sh/a.png?x-pxid=47894bd5-353b-42fe-bb97-74144e6df0bf" />
