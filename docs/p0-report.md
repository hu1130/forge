# P0 可行性验证报告

日期：2026-09-02  
结论：**部分通过，暂不可进入 P1。**

## 已通过

- Windows 本机存在 Codex CLI `0.151.0-alpha.7.2`。
- Node.js `v24.16.0` 可用；项目固定 pnpm `11.19.0`。
- `codex app-server --stdio` 可完成 `initialize` / `initialized` JSONL 握手。
- 已用当前 Codex 版本生成实验性 TypeScript 与 JSON Schema。
- 生成协议包含任务创建/恢复、中断、命令与文件审批、MCP elicitation、Skills 列表和子 Agent 事件。
- Provider 契约明确禁止自动 fallback，并覆盖全部目标厂商。

复现命令：

```powershell
pnpm test
pnpm p0:probe
```

## 阻塞项

除 DeepSeek 已完成首个适配器外，其余路径尚未执行真实调用，因此不能判定对应 Provider Gateway 可行性：

| 路径 | 状态 | 原因 |
|---|---|---|
| OpenAI | blocked | 未检测到 `OPENAI_API_KEY` |
| Claude | blocked | 未检测到 `ANTHROPIC_API_KEY` |
| Gemini | blocked | 未检测到 Gemini/Google API Key |
| DeepSeek | adapter ready | App Server、Responses 请求、401 失败事件与无降级链路已验证；仍需有效 Key 验证内容生成、工具调用和取消 |
| 通义千问 | blocked | 未检测到 `DASHSCOPE_API_KEY` |
| 智谱 | blocked | 未检测到 `ZHIPUAI_API_KEY` |
| Moonshot | blocked | 未检测到 `MOONSHOT_API_KEY` |
| Ollama | blocked | 已安装客户端，但 `127.0.0.1:11434` 未运行 |

阻塞不代表失败。验收门槛不降低：每条路径仍需验证流式文本、工具调用和取消；适用模型还需验证图片输入。

## 风险结论

1. 当前 Codex CLI 版本带 `alpha` 标记。它适合 P0 探针，但在进入 P1 前必须明确是固定该版本，还是换成经过验证的稳定版本后重新生成协议。
2. App Server 本机协议成立，不等于 Claude/Gemini 协议转换成立；工具调用增量、工具调用 ID、停止原因和取消行为是主要风险。
3. 生成协议中的多智能体相关字段属于实验范围，P6 不能在没有版本契约测试的情况下直接依赖。
4. 后续多用户要求已经进入架构基线，但当前阶段不实现登录和租户权限，避免提前扩大范围。

## 进入 P1 的条件

- 所有目标 Provider 路径完成真实契约测试，或用户明确重新调整目标 Provider 范围。
- Codex CLI/App Server 版本选择得到确认并重新跑完协议测试。
- Provider Gateway 的事件模型能无损表达流式文本、工具调用、取消和图片输入。
- 没有通过自动切换模型、关闭工具或关闭审批来规避失败项。
