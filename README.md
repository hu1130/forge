# Forge

Forge 是一款 Windows 本机 AI 编程工作台。当前版本采用 React + Electron + Fastify + Codex App Server，模型只接入 DeepSeek；0.12 在 Cloud 账户基础上加入租户工作区隔离，本机模式仍可不登录使用。

## 当前版本已完成

- Forge Cloud 注册、登录、会话恢复、退出和当前账户接口；注册时原子创建用户、个人租户与 owner 成员关系
- PostgreSQL 用户、租户、成员和会话迁移；业务租户身份只由服务端会话产生，不接受客户端指定的租户 ID
- 密码使用带独立随机盐的 scrypt；数据库只保存会话令牌 SHA-256 摘要，浏览器使用 HttpOnly Cookie 和 CSRF 令牌
- 可选 Cloud 登录界面及工作台账户入口；未设置 Cloud API URL 时保持原有单机行为
- Electron 主进程使用 HttpOnly 会话向 Cloud API 复核用户和租户，渲染器不能指定租户 ID；验证后 Daemon 才切换租户资料
- 项目、任务、Skill、MCP 配置和 MCP 加密令牌按租户物理分目录；退出 Cloud 账户后切回原有本机资料
- PostgreSQL 租户资源登记表、服务端身份派生 API 与强制 Row-Level Security；只允许项目、任务、Skill、MCP 的非敏感元数据
- 项目文件夹选择，以及按项目和租户隔离的本地任务列表
- 新建、搜索、置顶、重命名、归档、恢复和永久删除任务
- DeepSeek 多轮会话；Daemon 重启后可恢复同一 App Server 线程
- 可从当前工作区搜索并选择最多 20 个上下文文件；路径随本轮消息保留，Agent 会优先读取，疑似密钥、越界路径和超大文件由 Daemon 拒绝
- SSE 流式状态与输出；任务结束后默认只显示总结和结果，命令与写文件过程可折叠查看
- 任务运行中可明确选择“补充当前任务”或“排到下一轮”；等待任务支持排序、取消，并会按顺序连续执行
- 停止或重启 Daemon 后不会丢失等待队列，可从队列第一项继续执行；DeepSeek 使用 Codex App Server 原生 steer/queue 协议，Demo 仅作本地模拟
- 命令执行和文件修改审批：允许一次、本次任务允许、拒绝
- 真实文件变更列表与 Diff 内容；每个模型回合会保存一个聚合代码检查点，可独立撤销或重新应用，也保留任务级批量操作
- 真实 Git 状态、当前分支、领先/落后和暂存状态；可逐项暂存或取消暂存，查看本地分支与最近提交
- 支持安全创建和切换本地分支，以及只提交已经暂存的内容；脏工作区不会自动 stash 或强制切换
- 基于 `node-pty` 和 xterm.js 的交互式 PowerShell 终端
- 停止正在执行的任务
- DeepSeek API Key 使用 Electron `safeStorage` 加密保存，不写入任务记录或命令行参数
- 首次启动配置向导，以及不发起模型对话的 DeepSeek API 连通测试
- Skills 文件夹导入、全局/项目作用域、启用、停用和删除
- MCP STDIO 与 HTTP 服务配置、连接状态、工具发现、启用、停用和删除
- MCP HTTP Bearer Token 使用 Electron `safeStorage` 加密保存；MCP 工具调用在任务过程区折叠展示
- Skill + MCP 扩展市场：搜索、分类、详情、一键安装、更新和卸载；支持 GitHub 远程 JSON 目录、缓存回退与内置精选目录
- 远程 Skill 安装包强制使用 GitHub HTTPS 地址并校验 SHA-256，同时限制压缩包路径、文件数量和解压大小
- Forge 使用独立的 Codex 数据目录，不读取或修改用户已有的 Codex 配置
- 安装版为每次本机运行生成临时 Daemon 会话令牌，未携带令牌的 API 请求会被拒绝
- 任务记录串行原子写入并保留备份；损坏文件会隔离，意外中断的任务会在重启后安全停止
- Electron 页面启用 CSP、渲染器沙箱、导航限制、权限默认拒绝和 IPC 来源校验
- Windows NSIS 安装程序，内置 Forge Daemon、Web 前端和已固定验证的 Codex CLI `0.153.4`

## 安装版使用

安装包位于：

```text
release/Forge-Setup-0.12.0.exe
```

1. 运行安装程序并启动 Forge。
2. 按首次使用向导选择要让 Agent 操作的代码目录。
3. 填入自己的 DeepSeek API Key，先点击“测试连接”，成功后“保存并开始”。
4. 打开“设置 → 扩展市场”，可搜索并安装精选 Skill 或 MCP；Skill 可选择全局或当前项目作用域。
5. 如需自己的 Skill，可在“设置 → Skills”中导入包含 `SKILL.md` 的文件夹；自定义 MCP 可在“设置 → MCP 服务”中添加。
6. 新建任务后可点击输入框左下角的回形针搜索并选择当前工作区文件，再发送需求；任务运行时可用输入框上方的选择器决定补充当前任务或排到下一轮。等待任务可以调整顺序或取消，停止后可点击“继续执行”。敏感命令、文件操作或按策略需要确认的 MCP 工具会先显示审批。任务完成后可在对话中独立撤销某一轮代码，也可在右侧检查全部 Diff。
7. 在右侧“Git”页签勾选文件进行暂存或取消暂存、查看最近提交、创建或切换本地分支，然后提交暂存区。Forge 不会处理未选择的路径，也不会自动 stash 或强制覆盖脏工作区。

Skill 导入的是一份 Forge 管理的副本，删除不会修改原始文件夹。STDIO MCP 的“继承环境变量名”只引用启动 Forge 时已经存在的环境变量，不在配置中保存变量值。HTTP MCP 令牌仅供 App Server 建立对应连接，Forge 会把这类变量从 Agent 启动的 Shell 子进程环境中排除。

当前安装包尚未购买代码签名证书，因此 Windows 可能显示“未知发布者”或 SmartScreen 提示。公开销售前必须完成 Authenticode 代码签名；此包适合本机验收和小范围测试。

免登录资料默认保存在 `%APPDATA%\Forge\daemon\state.json`；Cloud 资料保存在 `%APPDATA%\Forge\daemon\tenants\<租户哈希>\`。每个任务文件均保留备份，损坏数据会改名隔离。加密后的密钥保存在 `%APPDATA%\Forge\secure-config.json`，其中 MCP Token 按租户分组。升级后不会自动把原有本机资料合并到 Cloud 租户，退出登录仍可访问原资料。

## 开发运行

```powershell
pnpm install
pnpm dev
```

浏览器打开 `http://127.0.0.1:5173`。开发模式使用环境变量配置 DeepSeek：

```powershell
$env:DEEPSEEK_API_KEY = "你的 DeepSeek API Key"
pnpm dev
```

桌面开发壳：

```powershell
pnpm dev:desktop
```

### 运行多用户纵向切片

Cloud API 只连接 PostgreSQL，不会自动降级到 SQLite 或普通 JSON 文件。开发数据库使用仓库中的 Compose 配置：

```powershell
docker compose up -d postgres
pnpm dev:cloud
```

浏览器打开 `http://127.0.0.1:5173/?cloud=1`。开发默认连接非超级用户 `postgresql://forge_app:forge_app_dev_only@127.0.0.1:54329/forge`，以便实际执行 RLS；部署时必须通过 `DATABASE_URL` 使用 `NOSUPERUSER NOBYPASSRLS` 的独立生产角色，并通过 `FORGE_CLOUD_ORIGINS` 设置允许的 Web/桌面客户端来源。跨站 HTTPS 桌面客户端场景还需设置 `FORGE_CLOUD_COOKIE_SAMESITE=none`。

`apps/cloud-api` 是中心化账户与租户控制面，不会随桌面安装包分发，也不会把数据库连接信息交给 Electron 或浏览器。当前完整任务内容、代码、终端输出和扩展文件仍保存在按租户隔离的本机 Daemon；Cloud 资源 API 只登记白名单元数据，桌面端尚未自动上传或跨设备恢复这些元数据。

## 构建 Windows 安装包

构建机需先安装官方 Codex CLI `0.153.4`。也可以把 `FORGE_CODEX_SOURCE_DIR` 指向含该版本 `codex.exe` 的目录。构建脚本会严格校验 CLI 版本，打包 Forge Daemon，并把运行资源和第三方许可证放入安装包；版本不匹配时会停止构建，避免协议静默漂移。

```powershell
pnpm dist:win
```

构建结果输出到 `release/`。Codex CLI 与 Codex App Server 来自 OpenAI Codex 开源项目，许可证和上游 NOTICE 位于 `apps/desktop/third-party/`，并随安装包分发。

## 验证

```powershell
pnpm test
pnpm typecheck
pnpm build
node scripts/smoke-packaged-daemon.mjs
node scripts/verify-packaged-extensions.mjs
node scripts/verify-packaged-mcp-call.mjs
```

当前版本还不包含：邮箱验证与密码找回、MFA、团队邀请与角色管理、原有本机资料的一键导入、跨设备云同步与冲突处理、云端 Agent Worker 隔离、用量与计费、市场账号与用户发布、评分或付费、MCP OAuth 登录、多 Agent、OpenAI/Claude/Gemini 提供商、应用自动更新和商业代码签名。未接入能力不会自动降级成其他模型。

### 发布远程市场目录

开发版和安装版默认使用内置精选目录。将符合 `apps/daemon/resources/marketplace.json` 结构的远程目录发布到 GitHub 后，通过 `FORGE_MARKETPLACE_URL` 指向它的 Raw HTTPS 地址即可在线刷新。远程目录中的 Skill 必须使用 GitHub ZIP 下载地址、固定的 SHA-256，以及压缩包内包含 `SKILL.md` 的 `root` 路径；远程目录不能引用安装包内置路径。
