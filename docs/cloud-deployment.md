# Forge Cloud 部署

Forge 桌面端仍在用户电脑执行 Agent；这里只部署账户、租户和安全目录控制面。Cloud API 不应与桌面安装包共用数据库凭据。

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
```

`FORGE_CLOUD_TRUST_PROXY=1` 只适用于服务确实位于可信反向代理之后。不要使用 `*` 作为允许来源，也不要把数据库或邮件密钥写入镜像、Git 或桌面端。

## 构建和启动

从仓库根目录执行：

```powershell
docker build -f apps/cloud-api/Dockerfile -t forge-cloud:0.16.0 .
docker run --rm -p 4790:4790 --env-file .env.production forge-cloud:0.16.0
```

容器以非 root 用户运行，`/v1/health` 同时检查 Cloud API 和数据库。启动时迁移进程会取得 MySQL 命名锁，并只执行尚未登记的迁移，避免多实例重复迁移。MySQL 没有原生 Row-Level Security，因此运行账号不得拥有 DDL 权限，Cloud API 的所有租户资源操作必须同时通过活动成员校验和显式 `tenant_id` 条件。

## 上线验收

1. `GET /v1/health` 返回 `{ "ok": true }`。
2. 新用户注册后未验证邮箱不能读取租户数据。
3. 验证链接只能使用一次，24 小时后失效。
4. 密码重置链接只能使用一次，30 分钟后失效，并撤销该用户全部旧会话。
5. 两个真实账户使用相同资源键时仍只能读取各自租户数据。
6. 运行数据库账号执行 `ALTER TABLE` 会被拒绝。
7. 桌面安装包通过 `FORGE_CLOUD_API_URL=https://...` 连接；非本机 HTTP 地址会被拒绝。

仓库中的 `compose.yaml` 只用于本机开发，包含明确标注的开发密码，不能直接部署到公网。
