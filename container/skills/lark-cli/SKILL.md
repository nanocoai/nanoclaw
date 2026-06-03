---
name: lark-cli
description: 操作飞书多维表格(Bitable)、日历、任务、邮件、知识库等。当用户发飞书多维表格/wiki 表格链接、要求读写表格记录、查日历、建任务、发邮件时使用。补充 feishu-docs(后者只管 docx 文档读写和云盘上传)。
codex-shared: true
---

# 飞书 lark-cli 工具

`lark-cli` 是飞书官方命令行工具(全局安装,直接在 PATH 里),覆盖多维表格、日历、任务、邮件、知识库等 14 个业务域。挂的是 NanoClaw 自己的飞书应用,**bot 身份直接可读写应用有权限的租户资源,不需要用户授权**。

## 两个必记的坑

**1. 每条命令必须前缀 `LARK_CLI_NO_PROXY=1`**

容器/agent 环境里 `HTTPS_PROXY` 指向 onecli 网关,lark-cli 默认会走它 —— 连不上飞书,还会把凭据透传给网关。必须禁用:

```bash
LARK_CLI_NO_PROXY=1 lark-cli <command> ...
```

**2. 读租户共享资源用 `--as bot`**

应用权限在开发者后台发布后,bot(tenant)身份直接能读写,不用每次折腾用户授权。命令加 `--as bot`。
只有访问"某个用户个人的"数据(私人日历、私人邮件)才需要 user 身份,那时先 `lark-cli auth login` 走设备码授权。

## 核心用法

### 读多维表格(最常见)

用户发的多维表格常是 wiki 链接(形如 `https://xxx.feishu.cn/wiki/XXX?table=tblYYY`)。两步:

```bash
# 第 1 步:wiki 链接 → 拿 base-token(obj_token)和类型
LARK_CLI_NO_PROXY=1 lark-cli wiki +node-get \
  --node-token "https://xxx.feishu.cn/wiki/XXX?table=tblYYY" --as bot --format json
# 返回 data.obj_token 就是 base-token,data.obj_type 应为 bitable

# 第 2 步:读记录(table-id 取自链接里的 table=tblYYY,或 lark-cli base +table-list 查)
LARK_CLI_NO_PROXY=1 lark-cli base +record-list \
  --base-token <obj_token> --table-id tblYYY --limit 200 --as bot --format markdown
```

直接是 `https://xxx.feishu.cn/base/<base_token>?table=tblYYY` 的链接,则 `base_token` 已在 URL 里,跳过第 1 步。

常用 base 子命令(都加 `--as bot`):
- `+record-list` 读记录(`--filter-json`/`--sort-json`/`--field-id` 过滤投影,`--limit` 1-200)
- `+record-create` / `+record-update` / `+record-delete` 增改删
- `+field-list` 看字段、`+table-list` 看表清单
- `+data-query` JSON DSL 聚合/分析

### 其他域(都加 `LARK_CLI_NO_PROXY=1` 和 `--as bot`)

```bash
lark-cli calendar +agenda                    # 日历日程
lark-cli task ...                            # 任务
lark-cli im ...                              # 消息
lark-cli mail ...                            # 邮件
lark-cli sheets ...                          # 电子表格
lark-cli docs ... / lark-cli drive ...       # 文档/云盘
```

### 不确定参数时

```bash
lark-cli <域> --help                # 看子命令清单
lark-cli <域> <子命令> --help        # 看具体参数(注意:都用 --flag 传值,不支持位置参数)
lark-cli schema <service.resource.method> --format pretty   # 看 API schema
```

## 跟 feishu-docs 的分工

- **docx 文档读取 / 创建 / 云盘上传** → 继续用 `feishu-docs`(走 IPC user-token,能读用户私有文档)
- **多维表格 / 日历 / 任务 / 邮件 / 知识库节点** → 用 `lark-cli`(bot 身份)

## 注意事项

- 版本锁 1.0.46。配置和凭据在宿主 `~/.lark-cli/`(持久,重启不丢)。
- 报 `99991672 / app_scope_not_applied`:应用在开发者后台没申请该权限 → 需开发者去 console 申请并**发布新版本**(光申请不发布无效)。
- 报 `99991679`:用户身份授权缺失 → 改用 `--as bot`,或走 `lark-cli auth login` 设备码授权。
- 输出默认 markdown,程序化处理用 `--format json` 配 `-q/--jq` 过滤。
