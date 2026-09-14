# Forge Cloud 部署

Forge 桌面端仍在用户电脑执行 Agent；这里只部署账户、租户、安全目录和不透明加密备份控制面。Cloud API 不应与桌面安装包共用数据库凭据，也不能接收备份口令或任务明文。

## 运行要求

- Node.js 24，或使用 `apps/cloud-api/Dockerfile` 构建镜像。
- MySQL 8.4，并准备两个连接串：迁移账号拥有 DDL 权限，运行账号只有 `SELECT`、`INSERT`、`UPDATE`、`DELETE`。
- 一个 HTTPS Web 地址和明确的 CORS 来源列表。
- 已验证发件域名的 Resend API Key。生产环境缺少邮件配置时 Cloud API 会拒绝启动。

## 必需环境变量

```text
NODE_ENV=production
DATABASE_URL=mysql://运行账号:密码@数据库:3306/forge
FORGE_CLOUD_MIGRATION_DATABASE_URL=mysql://迁移账号:密码@数据库:3306/forge
FORGE_CLOUD_ORIGINS=https://forge.example.com
FORGE_CLOUD_PUBLIC_WEB_URL=https://forge.example.com/?cloud=1
FORGE_CLOUD_RESEND_API_KEY=由托管平台的 Secret Manager 注入
FORGE_CLOUD_EMAIL_FROM=Forge <no-reply@example.com>
FORGE_CLOUD_TRUST_PROXY=1
FORGE_CLOUD_DB_POOL_SIZE=10
FORGE_CLOUD_LOG_LEVEL=info
```

`FORGE_CLOUD_TRUST_PROXY=1` 只适用于服务确实位于可信反向代理之后。不要使用 `*` 作为允许来源，也不要把数据库或邮件密钥写入镜像、Git 或桌面端。

若安装版桌面客户端也要连接 Cloud API，额外显式配置固定的本机前端来源和跨站安全 Cookie：

```env
FORGE_CLOUD_ORIGINS=https://forge.example.com,http://127.0.0.1:4782
FORGE_CLOUD_COOKIE_SAMESITE=none
```

生产环境除 `127.0.0.1`、`localhost` 和 `[::1]` 回环来源外仍强制 HTTPS。不要添加其他本机端口，也不要使用通配符。

## 构建和启动

先从仓库根目录执行生产配置预检。预检不会输出数据库密码或 Resend Key：

```powershell
pnpm cloud:preflight
```

通过后构建和启动：

```powershell
docker build -f apps/cloud-api/Dockerfile -t forge-cloud:0.21.0 .
docker run --rm -p 4790:4790 --env-file .env.production forge-cloud:0.21.0
```

容器以非 root 用户运行，`/v1/live` 只检查进程存活，`/v1/health` 检查 Cloud API 和数据库就绪状态；每个响应都包含 `x-request-id`。生产日志会隐藏 Cookie、Authorization 和 Set-Cookie。启动时迁移进程会取得 MySQL 命名锁，并只执行尚未登记的迁移，避免多实例重复迁移。MySQL 没有原生 Row-Level Security，因此运行账号不得拥有 DDL 权限，Cloud API 的所有租户资源操作必须同时通过活动成员校验和显式 `tenant_id` 条件。

生产会话使用 `__Host-` Cookie；浏览器写请求缺少 Origin 或来源不在 `FORGE_CLOUD_ORIGINS` 时会被拒绝。登录设备的查询与撤销同时按用户和当前租户过滤，暂停成员资格会立即使该租户会话失效。

数据库自动快照、下载备份和恢复演练见 [MySQL 备份与恢复](mysql-backup.md)。

## 上线验收

1. `GET /v1/live` 和 `GET /v1/health` 都返回 `{ "ok": true }`，且响应包含 `x-request-id`。
2. 新用户注册后未验证邮箱不能读取租户数据。
3. 验证链接只能使用一次，24 小时后失效。
4. 密码重置链接只能使用一次，30 分钟后失效，并撤销该用户全部旧会话。
5. 两个真实账户使用相同资源键时仍只能读取各自租户数据。
6. 运行数据库账号执行 `ALTER TABLE` 会被拒绝。
7. 桌面安装包通过 `FORGE_CLOUD_API_URL=https://...` 连接；非本机 HTTP 地址会被拒绝。
8. 创建团队后可在个人与团队工作区之间切换，且本机 Daemon 身份与 Cloud 会话租户一致。
9. 邀请只能由匹配且已验证的邮箱接受；管理员不能邀请管理员，最后一位所有者不能被降级或移除。
10. 移除成员后，该成员在对应团队的旧会话立即失效，但个人工作区仍可正常登录。
11. 两个用户在同一团队分别上传备份时互不覆盖；错误口令、其他租户密文和篡改密文均无法恢复，重复恢复不会覆盖或复制本机已有版本。

仓库中的 `compose.yaml` 只用于本机开发，包含明确标注的开发密码，不能直接部署到公网。
