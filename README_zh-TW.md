<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  一個讓 agent 安全運行在各自獨立容器中的 AI 助手。輕量、易於理解，並可依你的需求完全客製化。
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="https://docs.nanoclaw.dev">文件</a>&nbsp; • &nbsp;
  <a href="README.md">English</a>&nbsp; • &nbsp;
  <a href="README_zh.md">简体中文</a>&nbsp; • &nbsp;
  <a href="README_ja.md">日本語</a>&nbsp; • &nbsp;
  <a href="README_ko.md">한국어</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="repo tokens" valign="middle"></a>
</p>

---

## 我為什麼打造 NanoClaw

[OpenClaw](https://github.com/openclaw/openclaw) 是一個令人印象深刻的專案，但要我把一套自己看不懂的複雜軟體交出對生活的完整存取權，我大概會睡不著。OpenClaw 有將近 50 萬行程式碼、53 個設定檔、70 多個相依套件，而它的安全防護停在應用層（白名單、配對碼），而非真正的作業系統層級隔離。所有東西都跑在單一個共用記憶體的 Node 程序裡。

NanoClaw 用一個小到你能真正讀懂的程式碼庫提供同樣的核心功能：一個程序、少數幾個檔案。Claude agent 運行在各自具備檔案系統隔離的 Linux 容器中，而不只是躲在權限檢查後面。

## 快速開始

```bash
git clone https://github.com/nanocoai/nanoclaw.git nanoclaw-v2
cd nanoclaw-v2
bash nanoclaw.sh
```

`nanoclaw.sh` 會帶你從一台全新的機器，一路走到一個你可以直接傳訊息的具名 agent。它會在缺少時安裝 Node、pnpm 與 Docker，向 OneCLI 註冊你的 Anthropic 憑證，建置 agent 容器，並配對你的第一個管道（Telegram、Discord、WhatsApp 或本地 CLI）。若某一步失敗，會自動呼叫 Claude Code 進行診斷，並從中斷處繼續。

<details>
<summary><strong>從 NanoClaw v1 遷移過來？</strong></summary>

在你的 v1 安裝旁邊，從一份全新的 v2 checkout 執行：

```bash
git clone https://github.com/nanocoai/nanoclaw.git nanoclaw-v2
cd nanoclaw-v2
bash migrate-v2.sh
```

`migrate-v2.sh` 會找到你的 v1 安裝（同層目錄，或 `NANOCLAW_V1_PATH=/path/to/nanoclaw`），把狀態遷移進 v2 checkout，接著 `exec` 進 Claude Code，完成需要判斷的部分（owner 種子資料、CLAUDE.local.md 清理、fork 客製化重播）。

請直接執行這個腳本，不要在 Claude session 裡面跑；它的確定性部分需要互動式提示，以及 Node/pnpm 引導、Docker、OneCLI 與容器建置所需的真實 shell I/O。

**它會做什麼：** 合併 `.env`，以 `registered_groups` 為 v2 資料庫植入種子資料，複製群組資料夾 + session 資料 + 排程任務，安裝你選擇的管道適配器，複製管道認證狀態（含 WhatsApp 的 Baileys keystore + LID 對應），並建置 agent 容器。

**它不會做什麼：** 切換系統服務。在提示時選擇 *「切換到 v2」*，或在測試後自行手動切換。你的 v1 安裝會原封不動。

差異說明見 [docs/v1-to-v2-changes.md](docs/v1-to-v2-changes.md)，開發筆記見 [docs/migration-dev.md](docs/migration-dev.md)。

</details>

## 設計哲學

**小到可以理解。** 單一程序、少數幾個原始檔，沒有微服務。如果你想搞懂整個 NanoClaw 程式碼庫，直接請 Claude Code 帶你走一遍就好。

**以隔離達成安全。** agent 運行在 Linux 容器裡，只能看到你明確掛載的東西。Bash 存取是安全的，因為指令是在容器內執行，而不是在你的主機上。

**為個別使用者打造。** NanoClaw 不是一套單體框架，而是能精準貼合每位使用者需求的軟體。它不走向臃腫，而是被設計成量身打造：你建立自己的 fork，讓 Claude Code 依你的需求去改它。

**客製化 = 修改程式碼。** 沒有設定氾濫。想要不同的行為？改程式碼。程式碼庫小到讓改動是安全的。

**AI 原生，混合式設計。** 安裝與上手流程走的是最佳化過的腳本路徑，快速且確定。當某一步需要判斷（安裝失敗、引導式決策，或客製化），控制權會無縫交給 Claude Code。安裝之後也沒有監控儀表板或除錯 UI：你在對話裡描述問題，Claude Code 就來處理。

**技能優於功能。** 主幹只發布註冊表與基礎設施，不含特定的管道適配器或替代 agent 提供者。各管道（Discord、Slack、Telegram、WhatsApp……）放在長期存在的 `channels` 分支；替代提供者（OpenCode、Ollama）放在 `providers` 分支。你執行 `/add-telegram`、`/add-opencode` 等等，技能就會把你需要的模組精準複製進你的 fork。不會有你沒要求的功能。

**最強的 harness，最強的模型。** NanoClaw 透過 Anthropic 官方的 Claude Agent SDK 原生使用 Claude Code，所以你能用上最新的 Claude 模型與 Claude Code 的完整工具集，包含修改與擴充你自己 NanoClaw fork 的能力。其他提供者則是隨插即用的選項：`/add-codex` 對應 OpenAI 的 Codex（ChatGPT 訂閱或 API key），`/add-opencode` 透過 OpenCode 接上 OpenRouter、Google、DeepSeek 等，`/add-ollama-provider` 用於本地開放權重模型。提供者可按 agent 群組分別設定。

## 支援哪些功能

- **多管道訊息**：WhatsApp、Telegram、Discord、Slack、Microsoft Teams、iMessage、Matrix、Google Chat、Webex、Linear、GitHub、WeChat，以及透過 Resend 的電子郵件。以 `/add-<channel>` 技能按需安裝。可同時運行一個或多個。
- **彈性隔離**：為每個管道配一個專屬 agent 以獲得完整隱私；讓一個 agent 橫跨多個管道以共用記憶但對話各自獨立；或把多個管道併進單一共用 session，讓一場對話橫跨多個入口。透過 `/manage-channels` 按管道選擇。詳見 [docs/isolation-model.md](docs/isolation-model.md)。
- **每個 agent 的專屬工作區**：每個 agent 群組都有自己的 `CLAUDE.md`、自己的記憶、自己的容器，以及只有你允許的掛載。除非你主動串接，否則沒有東西會跨越邊界。
- **排程任務**：會執行 Claude 並能回傳訊息給你的週期性作業。
- **網路存取**：搜尋並抓取網頁內容。
- **容器隔離**：agent 在 Docker（macOS/Linux/WSL2）中沙箱化運行，可選 [Docker Sandboxes](docs/docker-sandboxes.md) 的微虛擬機隔離，或在 macOS 上選用原生的 Apple Container。
- **憑證安全**：agent 絕不持有原始 API key。出站請求經由 [OneCLI 的 Agent Vault](https://github.com/onecli/onecli)，在請求當下注入憑證，並針對每個 agent 執行政策與速率限制。
- **Agent 範本**：從可重複使用的套件包一鍵產出一個開箱即用的 agent（指令 + MCP 工具 + 技能，不含密鑰），可透過設定精靈或 `ncl groups create --template <ref>`。來源可以是[公開範本](https://github.com/nanocoai/nanoclaw-templates)、本地資料夾，或任何 git repo。詳見 [docs/templates.md](docs/templates.md)。

## 使用方法

用觸發詞（預設：`@Andy`）和你的助手對話：

```
@Andy 每個工作日早上 9 點給我一份銷售管線總覽（可以存取我的 Obsidian vault 資料夾）
@Andy 每週五回顧過去一週的 git 歷史，如果和 README 有落差就更新它
@Andy 每週一早上 8 點，從 Hacker News 和 TechCrunch 彙整 AI 發展的新聞，傳一份簡報給我
```

在你擁有或管理的管道裡，你還可以管理群組與任務：

```
@Andy 列出所有群組的排程任務
@Andy 暫停週一簡報任務
@Andy 加入「家庭聊天」群組
```

## 客製化

NanoClaw 不使用設定檔。想做改動，直接告訴 Claude Code 你要什麼：

- 「把觸發詞改成 @Bob」
- 「記住以後回覆要更簡短、更直接」
- 「當我說早安時，加一句自訂問候」
- 「每週儲存一次對話摘要」

或執行 `/customize` 進行引導式修改。

程式碼庫夠小，Claude 可以安全地修改它。

## 貢獻

**不要加功能，要加技能。**

如果你想新增一個管道或 agent 提供者，別把它加到主幹上。新的管道適配器進入 `channels` 分支；新的 agent 提供者進入 `providers` 分支。使用者在自己的 fork 裡用 `/add-<name>` 技能來安裝，由技能把相關模組複製到標準路徑、接好註冊、釘住相依版本。

這讓主幹維持為純粹的註冊表與基礎設施，每個 fork 也保持精簡：使用者只拿到他們要求的管道與提供者，別無其他。

### RFS（技能徵集）

我們希望看到的技能：

**通訊管道**
- `/add-signal`：新增 Signal 作為管道

## 系統需求

- macOS 或 Linux（Windows 透過 WSL2）
- Node.js 20+ 與 pnpm 10+（安裝程式會在缺少時自動安裝兩者）
- [Docker Desktop](https://docker.com/products/docker-desktop)（macOS/Windows）或 Docker Engine（Linux）
- [Claude Code](https://claude.ai/download)，用於 `/customize`、`/debug`、安裝過程的錯誤復原，以及所有 `/add-<channel>` 技能

## 架構

```
訊息應用 → 主機程序（路由器） → inbound.db → 容器（Bun、Claude Agent SDK） → outbound.db → 主機程序（投遞） → 訊息應用
```

單一個 Node 主機負責編排每個 session 的 agent 容器。當一則訊息抵達，主機依實體模型（使用者 → 訊息群組 → agent 群組 → session）進行路由，寫入該 session 的 `inbound.db`，並喚醒容器。容器內的 agent-runner 輪詢 `inbound.db`、執行 Claude，並把回應寫入 `outbound.db`。主機輪詢 `outbound.db`，再透過管道適配器投遞回去。

每個 session 兩個 SQLite 檔案，每個檔案剛好只有一個寫入者：沒有跨掛載的鎖爭用、沒有 IPC、沒有 stdin 管線。管道與替代提供者在啟動時自我註冊；主幹提供註冊表與 Chat SDK 橋接，適配器本身則在每個 fork 裡由技能安裝。

完整架構說明見 [docs/architecture.md](docs/architecture.md)；三層隔離模型見 [docs/isolation-model.md](docs/isolation-model.md)。

關鍵檔案：
- `src/index.ts`：進入點（資料庫初始化、管道適配器、投遞輪詢、sweep）
- `src/router.ts`：入站路由（訊息群組 → agent 群組 → session → `inbound.db`）
- `src/delivery.ts`：輪詢 `outbound.db`，透過適配器投遞，處理系統動作
- `src/host-sweep.ts`：60 秒 sweep（失效偵測、到期訊息喚醒、循環排程）
- `src/session-manager.ts`：解析 session，開啟 `inbound.db` / `outbound.db`
- `src/container-runner.ts`：為每個 agent 群組啟動容器，OneCLI 憑證注入
- `src/db/`：中央資料庫（使用者、角色、agent 群組、訊息群組、串接、遷移）
- `src/channels/`：管道適配器基礎設施（適配器透過 `/add-<channel>` 技能安裝）
- `src/providers/`：主機側提供者設定（`claude` 內建；其他透過技能安裝）
- `container/agent-runner/`：Bun agent-runner（輪詢迴圈、MCP 工具、提供者抽象層）
- `groups/<folder>/`：每個 agent 群組的檔案系統（`CLAUDE.md`、技能、容器設定）

## 常見問題

**為什麼用 Docker？**

Docker 提供跨平台支援（macOS、Linux 以及透過 WSL2 的 Windows）與成熟的生態系。在 macOS 上，也支援以更輕量的原生執行環境 Apple Container。若需要額外隔離，[Docker Sandboxes](docs/docker-sandboxes.md) 會把每個容器放進一台微虛擬機裡運行。

**我可以在 Linux 或 Windows 上運行嗎？**

可以。Docker 是預設的執行環境，可在 macOS、Linux 與 Windows（透過 WSL2）上運作。執行 `bash nanoclaw.sh` 即可。

**這安全嗎？**

agent 運行在容器裡，而不是躲在應用層的權限檢查後面。它們只能存取明確掛載的目錄。憑證絕不進入容器：出站 API 請求經由 [OneCLI 的 Agent Vault](https://github.com/onecli/onecli)，在代理層注入認證，並支援速率限制與存取政策。你仍然應該檢視自己要運行的東西，但這個程式碼庫小到你真的做得到。完整的安全模型見[安全文件](https://docs.nanoclaw.dev/concepts/security)。

**為什麼沒有設定檔？**

我們不想要設定氾濫。每位使用者都該客製化 NanoClaw，讓程式碼精準做他們想做的事，而不是去設定一套通用系統。如果你偏好有設定檔，可以叫 Claude 幫你加。

**我可以使用第三方或開源模型嗎？**

可以。支援的做法是 `/add-opencode`（透過 OpenCode 設定接上 OpenRouter、OpenAI、Google、DeepSeek 等）或 `/add-ollama-provider`（透過 Ollama 使用本地開放權重模型）。兩者都可按 agent 群組分別設定，所以同一套安裝裡不同的 agent 可以跑在不同的後端上。

若只是一次性實驗，任何相容 Claude API 的端點也可以透過 `.env` 使用：

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

**我要怎麼除錯？**

問 Claude Code。「為什麼排程器沒在跑？」「最近的日誌裡有什麼？」「為什麼這則訊息沒有得到回覆？」這正是 NanoClaw 底層的 AI 原生做法。

**為什麼安裝對我不成功？**

若某一步失敗，`nanoclaw.sh` 會把控制權交給 Claude Code 來診斷並繼續。如果還是沒解決，執行 `claude`，然後 `/debug`。如果 Claude 找出一個可能影響其他使用者的問題，請對相關的安裝步驟或技能提一個 PR。

**我要怎麼解除安裝 NanoClaw？**

```bash
bash nanoclaw.sh --uninstall
```

每一份安裝都標記了各自 checkout 的 id，所以解除安裝程式只會移除屬於這份副本的東西：背景服務、容器與映像檔、應用資料與日誌、你 agent 的檔案，以及這份副本的 OneCLI vault agent。共用的東西（OneCLI 應用程式與你的憑證、機器上其他的 NanoClaw 副本）則不會被動到。它會清楚列出找到的東西，並逐群組請你確認；在你說 yes 之前不會刪除任何東西。用 `--dry-run` 可以預覽而不改動任何東西，或用 `--yes` 略過提示。移除前你的 `.env` 會先備份。最後，再自行刪掉 checkout 資料夾本身即可。

**什麼樣的變更會被接受進程式碼庫？**

進入基礎設定的，只有安全修復、bug 修復，以及明確的改進。就這些。

其他一切（新能力、作業系統相容性、硬體支援、增強功能）都應該以技能的形式貢獻：管道與提供者的程式碼放在 `channels`/`providers` 註冊分支上，其餘則作為自成一體的技能。詳見 [docs/customizing.md](docs/customizing.md) 與 [CONTRIBUTING.md](CONTRIBUTING.md)。

這讓基礎系統維持最小化，並讓每位使用者都能客製化自己的安裝，而不必繼承他們不想要的功能。

## 社群

有問題？有點子？[加入 Discord](https://discord.gg/VDdww8qS42)。

## 更新日誌

破壞性變更見 [CHANGELOG.md](CHANGELOG.md)，完整發布歷史見文件站的[完整發布紀錄](https://docs.nanoclaw.dev/changelog)。

## 授權

MIT
