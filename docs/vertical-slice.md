# 前后端纵向切片验收

## 已完成

- `apps/web`：React + Vite 共享前端，包含任务列表、活动时间线、输入区、模型选择、变更检查器、终端面板和设置弹窗。
- `apps/daemon`：Fastify 本机服务，包含任务 JSON 持久化、SSE 流式事件、停止任务、Provider 状态和生产静态资源托管。
- `apps/desktop`：Electron Windows 壳，启用 `contextIsolation`、禁用 `nodeIntegration`、启用沙箱并使用标题栏覆盖层。
- `packages/contracts`：前后端共享的任务、活动、运行时和流事件类型。
- `CodexBridge`：按官方 App Server 生命周期执行 `initialize` / `initialized`，稳定传输为 `stdio + JSONL`。
- `DeepSeek`：通过官方 Responses API 配置 Codex App Server，真实转发 assistant、命令和文件事件，并支持 `turn/interrupt`。

## 本机接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | Daemon 与 App Server 状态 |
| GET | `/api/bootstrap` | 工作区、任务、运行时和 Provider 初始化数据 |
| POST | `/api/tasks` | 新建本地任务 |
| GET | `/api/tasks/:id` | 读取任务历史 |
| POST | `/api/tasks/:id/turns` | 启动流式任务 |
| POST | `/api/tasks/:id/stop` | 停止当前任务 |

## 已验证

- App Server 返回 `ready`，传输状态为 `stdio / JSONL 已连接`。
- 演示任务按 SSE 增量到达；命令开始与完成按同一事件 ID 原位更新。
- 点击停止后 UI 保持 `已停止`，不会被较早的 `running` 状态覆盖。
- 未配置 OpenAI 时返回明确错误，并确认不会自动切换到演示或其他 Provider。
- 任务新建、首条消息自动命名和页面重载恢复均通过浏览器联调。
- Daemon 生产端口能够直接返回构建后的 Web 页面。
- Electron 无界面烟雾测试成功加载共享前端。
- 使用假 DeepSeek Key 完成非计费联调：App Server 握手成功，请求到达 `/responses`，401 被保留为失败事件且未自动降级。

## 尚未伪装成已完成的部分

当前 `demo` 是显式测试 Provider，DeepSeek 是首个真实 Provider。交互式工具审批、Git、终端、Skill 和 MCP 已经接入真实本机运行时；OpenAI、Claude、Gemini、其他 OpenAI-compatible Provider Gateway 与多 Agent 仍属于后续产品功能。在对应适配器完成前，界面会拒绝真实请求而不是静默降级。
