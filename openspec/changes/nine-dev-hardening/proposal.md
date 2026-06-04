## Why

2026-05-18 Issue #2183 暴露出 Nine DEV 环境三个系统性问题：

1. **配置管理混乱** — 4 个 yml 文件 + .env + 环境变量覆盖，四层叠加，无法一眼确定最终值。`docker.yml` 被手动填入生产凭证导致 worktree 部署串台。
2. **身份解析无防御** — `ResolveByFeishu` 通过 union_id 为已有用户创建新 identity 时不校验 app_id，导致异常应用的 open_id 被静默写入。
3. **部署缺乏自愈** — Docker daemon 重启后业务容器不自动恢复，nginx 因 upstream 不存在 crash loop，DEV 环境停服 40+ 分钟无告警。

PR #2188 堵住了直接诱因（docker.yml 被打包进镜像），但三个系统性问题未解决。本方案针对这三个问题提出加固措施。

## What Changes

### Phase 1: 配置收编（预计 1 天）

**目标：** 从"4 个 yml 文件 + 多层覆盖"简化为"1 个 base.yml + .env 环境变量注入"。

**改动清单：**

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `server/api/config/base.yml` | 所有环境共享的配置骨架，敏感字段用空值占位 |
| 删除 | `server/api/config/docker.yml` | 已废弃，凭证应通过 .env 注入 |
| 删除 | `api-config.yml`（项目根目录） | 被 base.yml + .env 替代 |
| 修改 | `deploy/docker-compose.yml` | go-api 的 volume mount 改为 `config/base.yml`，APP_CONF 指向它 |
| 修改 | `deploy/docker-compose.app.yml` | 同上，与主 compose 对齐 |
| 修改 | `.env.example` | 补充必填项文档：`FEISHU_APP_ID`、`FEISHU_APP_SECRET` 等 |
| 修改 | `deploy/dev.sh` | 启动前检查 `.env` 必填项是否存在，缺失则报错退出 |
| 保留 | `config/local.yml` | 本地裸机开发用（不走 Docker），不受影响 |
| 保留 | `config/prod.yml` | 生产环境用，不在本方案范围 |

**配置加载链简化为：**
```
base.yml（结构+默认值）
  ↓ 被 .env 里的环境变量覆盖（Go 代码已有 overrides map）
  = 最终配置
```

**`base.yml` 示例结构：**
```yaml
env: docker
http:
  host: 0.0.0.0
  port: 8000
data:
  db:
    user:
      driver: mysql
      # DSN 由环境变量 DB_DSN 覆盖
      dsn: ""
feishu:
  # 由环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET 覆盖
  app_id: ""
  app_secret: ""
```

**`dev.sh` 必填项检查：**
```bash
REQUIRED_VARS=(FEISHU_APP_ID FEISHU_APP_SECRET DB_HOST)
for var in "${REQUIRED_VARS[@]}"; do
  if ! grep -q "^${var}=" "$ENV_FILE"; then
    echo "❌ .env 缺少必填项: $var"
    echo "   参考 .env.example 填写后重试"
    exit 1
  fi
done
```

**remote.yml 处置：**
- `remote.yml` 当前用于 `go run` 直连 DEV MySQL 的场景
- 保留但不再作为容器化部署路径
- 其中的飞书凭证替换为环境变量占位

**迁移步骤：**
1. 创建 `base.yml`，从 `docker.yml` 提取结构，敏感值清空
2. DEV 服务器 `.env` 补充 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`
3. docker-compose.yml volume mount 改为 `config/base.yml`
4. 验证 CI 部署正常
5. 删除 `docker.yml` 和 `api-config.yml`
6. 更新 `.env.example` 和 README

### Phase 2: 身份防御（预计 0.5 天）

**目标：** `ResolveByFeishu` 通过 union_id 创建新 identity 时校验 app_id，不匹配则拒绝。

**改动清单：**

| 操作 | 文件 | 说明 |
|------|------|------|
| 修改 | `server/api/internal/identity/feishu.go` | union_id fallback 路径加 app_id 校验 |
| 修改 | `server/api/feishu/handler.go` | OAuth 回调时从飞书 token 响应提取 app_id 传入 opts |
| 新增 | `server/api/internal/identity/feishu_test.go` | 单元测试：app_id 不匹配时返回错误 |

**核心逻辑（feishu.go union_id fallback 路径）：**
```go
// 创建新 identity 前校验 app_id
expectedAppID := conf.GetString("feishu.app_id")
if opts.AppID != "" && opts.AppID != expectedAppID {
    logger.Error("identity app_id mismatch — 疑似配置串台",
        zap.String("expected_app_id", expectedAppID),
        zap.String("actual_app_id", opts.AppID),
        zap.String("union_id", opts.UnionID),
        zap.String("open_id", opts.OpenID),
    )
    return ResolveResult{}, fmt.Errorf(
        "identity: app_id mismatch (expected %s, got %s), refusing to create cross-app identity",
        expectedAppID, opts.AppID,
    )
}
```

**opts.AppID 来源：**
- 飞书 OAuth token 接口返回的 `app_id` 字段（`POST /open-apis/authen/v1/oidc/access_token` 响应中包含）
- 或直接从当前配置读取（`config.GetString("feishu.app_id")`），与 OAuth 授权 URL 中使用的 app_id 交叉验证

**向后兼容：**
- `opts.AppID` 为空时跳过校验（兼容旧的 bot 登录路径）
- 仅在 Web OAuth 的 union_id fallback 路径生效

### Phase 3: 部署自愈（预计 0.5 天）

**目标：** Docker 重启后自动恢复所有服务；部署脚本容错端口残留；异常时有告警。

**改动清单：**

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `deploy/docker-compose.yml` autoheal 服务 | 监控 unhealthy 容器自动重启 |
| 修改 | `deploy/docker-compose.yml` | MySQL/Redis restart 策略改为 `always` |
| 修改 | `deploy/scripts/deploy.sh` | 基础设施启动失败时自动 rm + recreate；nginx 前置健康检查 |
| 修改 | `deploy/scripts/deploy.sh` | 旧 slot 容器延迟 60s 删除（保留回滚窗口） |

**autoheal 容器（1 行新增服务）：**
```yaml
autoheal:
  image: willfarrell/autoheal
  environment:
    - AUTOHEAL_CONTAINER_LABEL=all
    - AUTOHEAL_INTERVAL=30
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock
  restart: always
```

**deploy.sh 端口残留容错：**
```bash
# 基础设施启动失败重试
for container in enterprise-ai-mysql enterprise-ai-redis; do
  if ! docker start "$container" 2>/dev/null; then
    echo "⚠️ $container 启动失败，清理后重建..."
    docker rm -f "$container" 2>/dev/null || true
    # 等 docker-proxy 释放端口
    sleep 2
    dc up -d "$service_name"
  fi
done
```

**deploy.sh nginx 前置检查：**
```bash
# 切流量前确认 nginx 在跑
if ! docker inspect nine-nginx --format='{{.State.Running}}' 2>/dev/null | grep -q true; then
  echo "⚠️ nginx 未运行，尝试拉起..."
  dc up -d nginx
  sleep 5
fi
```

**旧 slot 延迟删除：**
```bash
# 切流量成功后，旧 slot 停止但保留 60s
echo "🔄 旧 ${OLD_SLOT} 容器已停止，60s 后自动删除（回滚窗口）"
docker stop ${OLD_SLOT_CONTAINERS} 2>/dev/null || true
(sleep 60 && docker rm ${OLD_SLOT_CONTAINERS} 2>/dev/null) &
```

## Capabilities

### New Capabilities
- `config-single-source`: 单一配置文件 + 环境变量覆盖模式
- `identity-app-id-guard`: 身份解析 app_id 校验防护
- `deploy-autoheal`: 容器自愈 + 端口残留容错 + 旧 slot 回滚窗口

### Modified Capabilities
- `deploy-blue-green`: 增加 nginx 前置检查和延迟删除

## Impact

- **Go 代码改动**: ~20 行（feishu.go app_id 校验 + handler.go 传参）
- **配置文件**: 新增 1 个 `base.yml`，删除 2 个（`docker.yml` + `api-config.yml`）
- **部署脚本**: deploy.sh 新增 ~30 行容错逻辑
- **docker-compose**: 新增 autoheal 服务，修改 restart 策略
- **向后兼容**: 需要 DEV 服务器 `.env` 补充飞书凭证项（一次性操作）
- **风险**: Phase 1 涉及配置路径变更，需在 DEV 验证后再推生产

## Risks & Mitigations

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| base.yml 切换时 DEV .env 漏填字段 | 中 | go-api 启动 panic | dev.sh 前置检查 + CI 部署前验证 |
| autoheal 误重启健康容器 | 低 | 短暂服务中断 | AUTOHEAL_INTERVAL=30s，只对 unhealthy 生效 |
| app_id 校验误拦合法请求 | 低 | 用户登录失败 | opts.AppID 为空时跳过，仅 Web OAuth fallback 生效 |
| remote.yml 裸机开发者受影响 | 低 | 本地连 DEV 库需改 env | 保留 remote.yml，不在此方案删除 |

## Acceptance Criteria

- [ ] DEV 环境 go-api 容器从 `base.yml` + `.env` 加载配置，health check 通过
- [ ] `docker.yml` 和 `api-config.yml` 已删除，CI 部署正常
- [ ] worktree `dev.sh up` 正常启动，飞书 app_id 为 DEV 应用
- [ ] 用 Metal app_id 的 OAuth 请求被 ResolveByFeishu 拒绝并记录 ERROR 日志
- [ ] `systemctl restart docker` 后所有容器 60s 内自动恢复
- [ ] deploy.sh 遇到端口残留时能自动清理并重建容器

## Timeline

| 阶段 | 内容 | 预计耗时 | 依赖 |
|------|------|----------|------|
| Phase 1 | 配置收编 | 1 天 | 无 |
| Phase 2 | 身份防御 | 0.5 天 | 无（可与 Phase 1 并行） |
| Phase 3 | 部署自愈 | 0.5 天 | 无（可与 Phase 1 并行） |
| 验收 | DEV 全量验证 | 0.5 天 | Phase 1-3 完成 |

**总计：2 天**（Phase 1-3 可部分并行，实际日历时间约 2-3 天）
