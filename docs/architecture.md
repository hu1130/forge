# 架构基线

状态：已确认，P0 阶段。

## 运行结构

```text
共享 React Client
  ├─ Electron Desktop
  └─ 127.0.0.1 Web
          │
          ▼
本机 Node.js Daemon
  ├─ 会话与事件 API
  ├─ Provider Gateway
  ├─ 持久化与密钥访问
  └─ Codex App Server（stdio / JSONL）
```

Codex App Server 是唯一 Agent 执行底座。Provider Gateway 将各厂商的流式响应、工具调用、图片输入和取消语义转换为 App Server 所需协议；不在不同厂商之间自动切换。

内部连接固定使用 `stdio`，不依赖实验性的 App Server WebSocket 传输。产品自己的 Daemon 负责桌面端和本机 Web 端连接。

官方依据：

- [Codex App Server](https://developers.openai.com/codex/app-server)
- [Codex 自定义模型提供商](https://learn.chatgpt.com/codex/config-file/config-advanced)
- [Codex 开源组件](https://developers.openai.com/codex/open-source)

## 多用户演进边界

当前版本是 Windows 本机单用户模式，但从首个持久化版本开始：

- 所有用户拥有的数据均带 `tenant_id` 和 `user_id`。
- 本机模式使用固定的 `local` tenant 和当前 Windows 用户映射，不实现登录界面。
- 仓库、任务、消息、审批、密钥引用和 MCP 配置必须有明确所有者。
- API 层通过独立的 identity context 传递身份，不允许业务层读取全局“当前用户”。
- API Key 只保存安全存储引用，不进入普通业务表和事件日志。

后续多用户阶段再加入认证、会话管理、权限校验、租户隔离迁移和审计；P0-P7 不提前实现这些产品功能。

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

