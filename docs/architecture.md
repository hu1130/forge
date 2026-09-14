# 架构基线

状态：0.21 已完成 OpenWork 风格工作台与配置中心重建，并把默认模型、审批策略和检查器行为接入持久化配置；按用户与租户隔离的端到端加密任务备份继续保留。

## 运行结构

```text
Forge Cloud Web / Desktop（可选登录）
          │ HTTPS + HttpOnly Session
          ▼
中心 Cloud API
  ├─ 用户与会话
  ├─ 个人/团队租户与成员关系
  ├─ MySQL 租户资源登记（仅服务端连接）
  └─ 每用户不透明任务备份密文

共享 React Client
  ├─ Electron Desktop
  └─ 127.0.0.1 Web
          │
          ▼
本机 Node.js Daemon
  ├─ 会话与事件 API
  ├─ Provider Gateway
  ├─ 按租户哈希目录持久化
  ├─ 按租户读取 MCP 密钥
  └─ Codex App Server（stdio / JSONL）
```

Codex App Server 是唯一 Agent 执行底座。Provider Gateway 将各厂商的流式响应、工具调用、图片输入和取消语义转换为 App Server 所需协议；不在不同厂商之间自动切换。

内部连接固定使用 `stdio`，不依赖实验性的 App Server WebSocket 传输。产品自己的 Daemon 负责桌面端和本机 Web 端连接。

官方依据：

- [Codex App Server](https://developers.openai.com/codex/app-server)
- [Codex 自定义模型提供商](https://learn.chatgpt.com/codex/config-file/config-advanced)
- [Codex 开源组件](https://developers.openai.com/codex/open-source)

## 多用户演进边界

0.11 已经实现：

- `apps/cloud-api` 独立承载注册、登录、退出和账户上下文，不和本机 Daemon 共用数据库凭据。
- 用户注册时在同一 PostgreSQL 事务中创建个人租户和 owner 成员关系。
- 会话令牌使用高熵随机值，数据库只保存摘要；密码使用 scrypt 慢哈希。
- Cloud API 从服务端会话解析 `user_id`、`tenant_id` 和角色，忽略客户端伪造的租户头。
- 本机模式未配置 Cloud API URL 时保持免登录，避免破坏现有安装版。

0.12 已经实现：

- Electron 主进程直接使用 Cloud HttpOnly Cookie 复核会话，渲染器不传入 `tenant_id` 或 `user_id`。
- 验证后以 `FORGE_TENANT_ID` 和 `FORGE_USER_ID` 启动本机 Daemon；任务、项目路径、Skill、MCP 配置及 MCP Token 按租户隔离。
- 原 `local` 资料继续使用旧路径；Cloud 租户使用不可逆哈希目录，退出登录会切回本机资料且不会自动合并。
- Cloud API 提供租户资源登记接口，服务端从会话注入所有者，拒绝客户端租户头以及代码、路径、对话和密钥字段。
- `forge_tenant_resources` 同时使用显式租户条件、活动成员检查和 PostgreSQL FORCE RLS；开发连接使用 `NOBYPASSRLS` 应用角色。

0.13 已经实现：

- Cloud 租户可由用户明确触发，把旧 `local` 任务复制到租户目录；来源 ID 写入导入标记，重复操作保持幂等，原资料不会删除。
- 导入保留本机对话和代码变更记录，但不迁移断开的 Agent 会话或等待队列；完整内容仍只存在本机租户目录。
- 任务目录同步只上传名称、置顶、归档状态与更新时间；本机保存资源版本和上次同步时的任务时间戳。
- 只有单边变化时自动合并；本机与 Cloud 都变化时返回明确冲突，由用户选择“使用本机”或“使用云端”。
- Cloud API 支持预期版本写入，旧版本返回 `409` 和当前资源；迁移凭据与运行时应用凭据分离，运行角色不能修改 RLS 表结构。

0.14 已经实现：

- Cloud 租户可手动同步从 Forge 扩展市场安装的 Skill/MCP 安全目录；全局 Skill 和市场 MCP 使用稳定目录键，项目 Skill 保持本机记录身份。
- Cloud 只接收市场 ID、版本、作用域、连接类型、审批模式、启用状态和更新时间；自定义扩展、Skill 内容、MCP 命令、地址、参数、环境变量、Token 与本机路径不会进入同步载荷。
- 扩展目录沿用本机回执与 Cloud 乐观并发版本：首次上传、重复同步、单边合并和双边冲突都具有明确行为，冲突不会静默覆盖。
- 应用云端扩展状态后会刷新 Skill 根目录或重启 MCP 运行时；刷新失败时恢复原本机状态和同步回执。

0.15 已经实现：

- 生产 Cloud 账户启用邮箱验证；验证前只能维护账户与会话，不能读取或修改租户资源。
- 邮箱验证和密码重置使用独立的一次性令牌，数据库仅保存摘要；验证链接 24 小时失效，重置链接 30 分钟失效。
- 忘记密码接口对已注册和未注册邮箱返回相同结果；密码重置会撤销该用户的全部旧会话。
- 账户页可查看有效会话并撤销单个或其他全部会话；当前版本有意不采集设备名、IP 与硬件指纹。
- PostgreSQL 迁移加入 advisory lock 与迁移台账；真实数据库验收覆盖令牌单次消费、会话归属和 FORCE RLS 租户隔离。
- Cloud API 提供非 root Node 24 容器、健康检查、生产环境强校验和 Resend 邮件投递适配；桌面安装包仍不携带数据库凭据。

0.16 已经实现：

- Cloud API 数据库驱动由 `pg` 切换为 `mysql2`，迁移脚本和本机 Compose 基线改为 MySQL 8.4。
- 租户资源操作保留服务端身份派生、活动成员校验和显式 `tenant_id` 条件；运行账号只授予 DML 权限。MySQL 不提供 PostgreSQL 原生 RLS，这一差异不会被隐藏。
- MySQL 迁移使用命名锁和迁移台账；真实数据库验收覆盖令牌单次消费、会话归属、跨租户成员拒绝和运行账号 DDL 拒绝。

0.17 已经实现：

- 生产启动前统一验证 MySQL 协议、运行与迁移账号分离、HTTPS 来源、反向代理、邮件配置和开发密码泄漏风险。
- Cloud API 响应携带请求 ID，生产日志隐藏会话与认证头；存活探针与数据库就绪检查分离。
- 提供不在命令行暴露数据库密码的 MySQL 压缩备份工具，以及必须显式确认数据库名的恢复工具与演练清单。

0.18 已经实现：

- 登录设备查询、单个撤销和“退出其他设备”均同时限定 `user_id` 与 `tenant_id`，不会跨工作区处理会话。
- 成员资格暂停后，已有 Cloud 会话和租户资源访问立即失效；真实 MySQL 验收覆盖同一用户的双租户场景。
- 生产环境使用 `__Host-` 会话 Cookie，所有写请求必须携带可信 Origin，并返回 CSP、禁止嵌入和权限策略响应头。

0.19 已经实现：

- 已验证账户可创建团队租户，并列出自己拥有活动成员资格的个人与团队工作区。
- 团队邀请使用限时一次性链接；接受时同时校验登录账户、已验证邮箱和邀请邮箱，未注册用户注册并验证后也能从待处理邀请中继续接受。
- 所有者可以调整成员角色和移除成员；管理员只能邀请普通成员；数据库事务锁保护“至少一位活动所有者”的不变量。
- 工作区切换先校验目标活动成员资格，再轮换浏览器会话；前端随后重载并要求本机 Daemon 激活相同租户。
- 移除成员会暂停其团队成员资格并撤销该用户在该租户的全部会话，不影响其个人租户或其他团队。

0.20 已经实现：

- Daemon 从当前租户任务生成便携快照，移除工作区根路径、上下文绝对路径、旧 Agent 会话和等待队列，再使用 gzip、scrypt 与 AES-256-GCM 在本机完成压缩和认证加密。
- Cloud API 只接收格式受限的密文封装，按 `tenant_id + user_id` 保存每位用户的最新版本；上传使用乐观版本控制，读取、替换和删除都从 HttpOnly 会话派生身份。
- 恢复时密文先下载到客户端，再把口令和密文发送给本机 Daemon 解密；口令、派生密钥和明文不进入 Cloud API。GCM 同时绑定租户、用户、创建时间和任务数，错误口令、跨租户恢复和篡改均会失败。
- 恢复操作只导入不存在的任务版本，不覆盖或删除本机记录；旧 Diff 标记为便携只读，避免在另一工作区误应用，但恢复后新产生的代码变更仍可正常操作。

0.21 已经实现：

- 工作台重建为轻量三栏桌面结构，项目与任务、对话执行、Diff/Git/终端各自保持清晰边界；窄窗口把检查器切换为抽屉。
- 设置中心使用独立应用栏、分组导航和宽内容区，重新组织已有模型、市场、Skill、MCP、运行时、账户同步与备份功能。
- 默认模型、审批策略、默认检查器和检查器记忆状态由 Daemon 校验并原子持久化；审批策略在新建、恢复和继续 DeepSeek 会话时传给 Codex App Server。
- 舒适/紧凑密度和减少动画属于本机界面配置；尚未实现的 Automations、Apps、远程工作区和自动更新没有伪造入口。

后续租户业务数据遵循：

- 所有用户拥有的数据均带 `tenant_id` 和 `user_id`。
- 本机模式使用固定的 `local` tenant 和当前 Windows 用户映射。
- 仓库、任务、消息、审批、密钥引用和 MCP 配置必须有明确所有者。
- API 层通过独立的 identity context 传递身份，不允许业务层读取全局“当前用户”。
- API Key 只保存安全存储引用，不进入普通业务表和事件日志。

下一阶段加入 MFA 与不可篡改的账户/团队审计日志；之后再设计用量、套餐和计费。工作区代码、扩展配置、密钥、旧 Agent 会话和等待队列默认继续留在用户本机。

## 计划目录

```text
apps/
  client/              # 桌面与 Web 共用 React UI
  desktop/             # Electron main、preload、托盘与打包
  daemon/              # 本机服务、WebSocket、静态 Web 托管
packages/
  protocol/            # 统一事件和 API 契约
  codex-bridge/        # App Server stdio 生命周期和版本适配
  provider-gateway/    # OpenAI、Anthropic、Google、兼容接口
  workspace/           # 文件、搜索、路径边界
  approvals/           # 命令、文件和 MCP 审批
  terminal/            # Windows PTY
  git/                 # Git 状态、Diff 和本地操作
  mcp/
  skills/
  persistence/
  config/
spikes/                # 仅用于 P0 可行性验证
tests/
  contracts/
  integration/
  e2e/
vendor/
  codex-schema/        # 与固定 Codex 版本匹配的生成协议
```

## 已确认的功能边界

- Git UI：状态、Diff、暂存、取消暂存、提交和本地分支；远端操作先通过终端并单独审批。
- 文件区：查看和 Diff，不建设完整 IDE、调试器或扩展市场。
- 历史恢复：恢复记录后发起新的继续回合，不恢复已经断开的厂商 API 流。
- 模型失败：明确报错，不自动切换模型、厂商或 API。
- 当前 Web：仅回环地址，由桌面托盘 Daemon 提供；暂不实现 Windows 服务和局域网访问。
