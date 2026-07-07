<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  エージェントを専用コンテナで安全に実行するAIアシスタント。軽量で、理解しやすく、あなたのニーズに完全にカスタマイズできるように設計されています。
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="https://docs.nanoclaw.dev">ドキュメント</a>&nbsp; • &nbsp;
  <a href="README.md">English</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="README_ko.md">한국어</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="repo tokens" valign="middle"></a>
</p>

---

## NanoClawを作った理由

[OpenClaw](https://github.com/openclaw/openclaw)は素晴らしいプロジェクトですが、自分が理解しきれない複雑なソフトウェアに生活へのフルアクセスを与えたまま安心して眠れるとは思えませんでした。OpenClawは約50万行のコード、53の設定ファイル、70以上の依存関係を持っています。セキュリティはアプリケーションレベル（許可リスト、ペアリングコード）であり、真のOSレベルの分離ではありません。すべてが共有メモリを持つ1つのNodeプロセスで動作します。

NanoClawは同じコア機能を提供しますが、理解できる規模のコードベースで実現しています。1つのプロセスと少数のファイル。Claudeエージェントは単なるパーミッションチェックの背後ではなく、ファイルシステム分離された独自のLinuxコンテナで実行されます。

## クイックスタート

```bash
git clone https://github.com/nanocoai/nanoclaw.git nanoclaw-v2
cd nanoclaw-v2
bash nanoclaw.sh
```

`nanoclaw.sh`は、まっさらなマシンから、メッセージを送れる名前付きエージェントが動く状態までを一気通貫で案内します。NodeやpnpmやDockerが無ければインストールし、AnthropicクレデンシャルをOneCLIに登録し、エージェントコンテナをビルドし、最初のチャネル（Telegram、Discord、WhatsApp、またはローカルCLI）とペアリングします。途中でステップが失敗すれば自動的にClaude Codeが呼び出され、原因を診断して中断箇所から再開します。

## 設計思想

**理解できる規模。** 1つのプロセス、少数のソースファイル、マイクロサービスなし。NanoClawのコードベース全体を把握したいなら、Claude Codeに説明を求めれば十分です。

**分離によるセキュリティ。** エージェントはLinuxコンテナで実行され、明示的にマウントされたものだけが見えます。コマンドはホストではなくコンテナ内で実行されるため、Bashアクセスも安全です。

**個人ユーザー向け。** NanoClawはモノリシックなフレームワークではなく、各ユーザーのニーズに正確にフィットするソフトウェアです。肥大化するのではなく、オーダーメイドであるよう設計されています。自分のフォークを作り、Claude Codeにニーズに合わせて変更させます。

**カスタマイズ＝コード変更。** 設定の肥大化はありません。動作を変えたいならコードを変える。コードベースは変更しても安全な規模です。

**AIネイティブ、設計としてハイブリッド。** インストールとオンボーディングは最適化されたスクリプトのパスで、速く決定的です。判断が必要なところ（インストール失敗、対話的な決定、カスタマイズ）では、制御はシームレスにClaude Codeへ渡されます。セットアップ以降も、監視ダッシュボードやデバッグUIは用意しません。問題をチャットで説明すれば、Claude Codeが処理します。

**機能ではなくスキル。** トランクにはレジストリとインフラのみを同梱し、個別のチャネルアダプターや代替プロバイダーは含めません。チャネル（Discord、Slack、Telegram、WhatsAppなど）は長期運用される`channels`ブランチに、代替プロバイダー（OpenCode、Ollama）は`providers`ブランチに置かれます。`/add-telegram`や`/add-opencode`などを実行すると、スキルが必要なモジュールだけを正確にフォークへコピーします。要求していない機能は一切入りません。

**最高のハーネス、最高のモデル。** NanoClawはAnthropic公式のClaude Agent SDK経由でネイティブにClaude Codeを使用します。最新のClaudeモデルとClaude Codeの全ツールセット（自分のNanoClawフォークを変更・拡張する能力を含む）が手に入ります。他プロバイダーはドロップイン・オプションです。OpenAIのCodex（ChatGPTサブスクリプションまたはAPIキー）向けには`/add-codex`、OpenCode経由のOpenRouter、Google、DeepSeekなどには`/add-opencode`、ローカルのオープンウェイトモデルには`/add-ollama-provider`。プロバイダーはエージェントグループごとに設定可能です。

## サポート機能

- **マルチチャネルメッセージング** — WhatsApp、Telegram、Discord、Slack、Microsoft Teams、iMessage、Matrix、Google Chat、Webex、Linear、GitHub、WeChat、Resend経由のメール。`/add-<channel>`スキルでオンデマンドにインストール。1つでも複数でも同時に実行可能。
- **柔軟な分離モデル** — チャネルごとに専用エージェントを割り当てて完全プライバシーを確保することも、複数チャネルで1つのエージェントを共有して会話は分離しつつメモリを統一することも、複数チャネルを1つの共有セッションにまとめて会話を横断させることもできます。`/manage-channels`でチャネル単位に選択。[docs/isolation-model.md](docs/isolation-model.md)参照。
- **エージェントごとのワークスペース** — 各エージェントグループは独自の`CLAUDE.md`、独自のメモリ、独自のコンテナ、そしてあなたが許可したマウントのみを持ちます。明示的に配線しない限り、境界を越えるものはありません。
- **スケジュールタスク** — Claudeを実行し、結果を返信できる定期ジョブ。
- **Webアクセス** — Webからの検索とコンテンツ取得。
- **コンテナ分離** — エージェントはDockerでサンドボックス化されます（macOS/Linux/WSL2）。[Docker Sandboxes](docs/docker-sandboxes.md)によるマイクロVM分離や、macOSネイティブのオプトインとしてApple Containerも選択可能です。
- **クレデンシャルのセキュリティ** — エージェントは生のAPIキーを保持しません。アウトバウンドリクエストは[OneCLI Agent Vault](https://github.com/onecli/onecli)を経由し、リクエスト時に認証情報を注入して、エージェントごとのポリシーとレート制限を適用します。

## 使い方

トリガーワード（デフォルト：`@Andy`）でアシスタントに話しかけます：

```
@Andy 毎朝9時に営業パイプラインの概要を送って（Obsidian vaultフォルダにアクセス可能）
@Andy 毎週金曜に過去1週間のgit履歴をレビューして、差異があればREADMEを更新して
@Andy 毎週月曜の朝8時に、Hacker NewsとTechCrunchからAI関連のニュースをまとめてブリーフィングを送って
```

所有または管理しているチャネルからは、グループやタスクを管理できます：
```
@Andy 全グループのスケジュールタスクを一覧表示して
@Andy 月曜のブリーフィングタスクを一時停止して
@Andy Family Chatグループに参加して
```

## カスタマイズ

NanoClawは設定ファイルを使いません。変更したいときは、Claude Codeにやりたいことを伝えるだけです：

- 「トリガーワードを@Bobに変更して」
- 「今後はレスポンスをもっと短く直接的にして」
- 「おはようと言ったらカスタム挨拶を追加して」
- 「会話の要約を毎週保存して」

または`/customize`を実行すればガイド付きで変更できます。

コードベースは十分に小さいため、Claudeが安全に変更できます。

## コントリビューション

**機能を追加するのではなく、スキルを追加してください。**

新しいチャネルやエージェントプロバイダーを追加したい場合、トランクには追加しないでください。新しいチャネルアダプターは`channels`ブランチに、新しいエージェントプロバイダーは`providers`ブランチに追加します。ユーザーはそれぞれのフォークで`/add-<name>`スキルを実行し、スキルが必要なモジュールを標準パスへコピーし、登録を配線し、依存関係をピン留めします。

こうすることでトランクは純粋なレジストリ／インフラのまま保たれ、どのフォークもスリムなままです。ユーザーは求めたチャネルとプロバイダーだけを受け取り、それ以外は入りません。

### RFS（スキル募集）

私たちが見たいスキル：

**コミュニケーションチャネル**
- `/add-signal` — Signalをチャネルとして追加

## 必要条件

- macOSまたはLinux（WindowsはWSL2経由）
- Node.js 20以上とpnpm 10以上（インストーラーが未インストールなら両方をインストールします）
- [Docker Desktop](https://docker.com/products/docker-desktop)（macOS/Windows）または Docker Engine（Linux）
- [Claude Code](https://claude.ai/download)（`/customize`、`/debug`、セットアップ時のエラー復旧、全ての`/add-<channel>`スキルで使用）

## アーキテクチャ

```
メッセージングアプリ → ホストプロセス（ルーター） → inbound.db → コンテナ（Bun、Claude Agent SDK） → outbound.db → ホストプロセス（配信） → メッセージングアプリ
```

単一のNodeホストがセッションごとのエージェントコンテナをオーケストレーションします。メッセージが到着すると、ホストはエンティティモデル（ユーザー → メッセージンググループ → エージェントグループ → セッション）に沿ってルーティングし、セッションの`inbound.db`に書き込み、コンテナを起こします。コンテナ内部のagent-runnerは`inbound.db`をポーリングしてClaudeを実行し、レスポンスを`outbound.db`に書き込みます。ホストは`outbound.db`をポーリングし、チャネルアダプターを通じて配信します。

セッションごとに2つのSQLiteファイル、各ファイルにライターは1つだけ — クロスマウントの競合なし、IPCなし、stdinパイプなし。チャネルと代替プロバイダーは起動時に自己登録します。トランクはレジストリとChat SDKブリッジを同梱し、アダプター本体はフォークごとにスキルでインストールされます。

詳しいアーキテクチャ説明は[docs/architecture.md](docs/architecture.md)を、3階層の分離モデルについては[docs/isolation-model.md](docs/isolation-model.md)を参照してください。

主要ファイル：
- `src/index.ts` — エントリーポイント：DB初期化、チャネルアダプター、配信ポーリング、sweep
- `src/router.ts` — インバウンドルーティング：メッセージンググループ → エージェントグループ → セッション → `inbound.db`
- `src/delivery.ts` — `outbound.db`をポーリングし、アダプター経由で配信、システムアクションを処理
- `src/host-sweep.ts` — 60秒ごとのsweep：ストール検出、期限到来メッセージの起動、繰り返し
- `src/session-manager.ts` — セッションの解決、`inbound.db`と`outbound.db`のオープン
- `src/container-runner.ts` — エージェントグループごとのコンテナ起動、OneCLIによるクレデンシャル注入
- `src/db/` — セントラルDB（ユーザー、ロール、エージェントグループ、メッセージンググループ、配線、マイグレーション）
- `src/channels/` — チャネルアダプターのインフラ（アダプターは`/add-<channel>`スキルでインストール）
- `src/providers/` — ホスト側プロバイダー設定（`claude`はバンドル、その他はスキル経由）
- `container/agent-runner/` — Bun製agent-runner：ポーリングループ、MCPツール、プロバイダー抽象化
- `groups/<folder>/` — エージェントグループごとのファイルシステム（`CLAUDE.md`、スキル、コンテナ設定）

## FAQ

**なぜDockerなのか？**

Dockerはクロスプラットフォーム対応（macOS、Linux、WSL2経由のWindows）と成熟したエコシステムを提供します。macOSでは、`/convert-to-apple-container`でオプションとしてApple Containerに切り替え、より軽量なネイティブランタイムを使えます。さらに強い分離が必要なら、[Docker Sandboxes](docs/docker-sandboxes.md)が各コンテナをマイクロVM内で動作させます。

**LinuxやWindowsで実行できますか？**

はい。Dockerがデフォルトのランタイムで、macOS、Linux、Windows（WSL2経由）で動作します。`bash nanoclaw.sh`を実行するだけです。

**セキュリティは大丈夫ですか？**

エージェントはアプリケーションレベルのパーミッションチェックではなく、コンテナ内で実行されます。明示的にマウントされたディレクトリのみアクセス可能です。クレデンシャルはコンテナに渡されず、アウトバウンドAPIリクエストは[OneCLI Agent Vault](https://github.com/onecli/onecli)を経由し、プロキシレベルで認証を注入し、レートリミットやアクセスポリシーをサポートします。実行するものはレビューすべきですが、コードベースは実際にレビュー可能な規模です。完全なセキュリティモデルについては[セキュリティドキュメント](https://docs.nanoclaw.dev/concepts/security)を参照してください。

**なぜ設定ファイルがないのか？**

設定の肥大化を避けたいからです。すべてのユーザーがNanoClawをカスタマイズし、汎用的なシステムを設定するのではなくコードが自分の望み通りに動くようにすべきです。設定ファイルが欲しければClaudeに追加するよう伝えれば実現できます。

**サードパーティやオープンソースモデルを使えますか？**

はい。推奨される方法は`/add-opencode`（OpenCode設定経由でOpenRouter、OpenAI、Google、DeepSeekなど）か`/add-ollama-provider`（Ollama経由でローカルのオープンウェイトモデル）です。どちらもエージェントグループごとに設定可能なので、同じインストール内で異なるエージェントが異なるバックエンドで動作できます。

一時的な実験用には、Claude API互換のエンドポイントも`.env`で利用できます：

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

**問題のデバッグ方法は？**

Claude Codeに聞いてください。「スケジューラーが動いていないのはなぜ？」「最近のログには何がある？」「このメッセージに返信がなかったのはなぜ？」これがNanoClawの基盤となるAIネイティブなアプローチです。

**セットアップがうまくいかない場合は？**

ステップが失敗した場合、`nanoclaw.sh`は診断と再開のためにClaude Codeへ制御を渡します。それでも解決しなければ、`claude`を実行して`/debug`を呼び出してください。他のユーザーにも影響しそうな問題をClaudeが特定した場合は、該当のセットアップステップまたはスキルにPRを送ってください。

**どのような変更がコードベースに受け入れられますか？**

ベース設定に受け入れられるのは、セキュリティ修正、バグ修正、明確な改善のみです。それだけです。

それ以外（新機能、OS互換性、ハードウェアサポート、拡張など）は、`channels`または`providers`ブランチのスキルとしてコントリビュートしてください。

これにより、ベースシステムを最小限に保ち、全ユーザーが不要な機能を継承することなく自分のインストールをカスタマイズできます。

## コミュニティ

質問やアイデアがありますか？[Discordに参加](https://discord.gg/VDdww8qS42)してください。

## 変更履歴

破壊的変更については[CHANGELOG.md](CHANGELOG.md)を、完全なリリース履歴はドキュメントサイトの[full release history](https://docs.nanoclaw.dev/changelog)を参照してください。

## ライセンス

MIT
