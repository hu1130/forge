# kb-qa · 知识库问答演示

一个**离线可跑、可平滑升级**的知识库问答小项目，正好落在这个定位上：FastAPI 提供接口 + 一个简单静态前端。

- 默认离线：读取本地 Markdown 文档 → 中文分词 + BM25 检索 → 返回答案与引用片段，**不需要任何大模型 Key**。
- 可平滑升级：配置一个 OpenAI 兼容 Key（默认适配 DeepSeek）后重启，同一套接口自动升级为“检索 + 大模型生成”。
- 前端是 FastAPI 直接托管的单个静态 HTML 页面（方案 2A），一次命令启动，浏览器即用。

## 目录结构

```text
kb-qa/
  app/
    main.py        # FastAPI 服务：/api/health、/api/chat、/api/reload、/
    retriever.py   # 分块 + 中文分词 + BM25（核心只用标准库，jieba 是可选增强）
    llm.py         # 可选 LLM 升级层（OpenAI 兼容 / 默认 DeepSeek，标准库 urllib）
  static/
    index.html     # 单文件前端页面
  data/
    sample.md      # 示例知识库（可替换成你自己的 Markdown 文档）
  tests/
    test_retriever.py
  requirements.txt
```

## 快速开始（Windows PowerShell）

```powershell
cd kb-qa
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000
```

浏览器打开 <http://127.0.0.1:8000>，接口文档见 <http://127.0.0.1:8000/docs>。

> 说明：首次运行无任何 Key 时即为离线检索模式；页面左上角徽标会显示当前是「离线检索」还是「RAG · 检索 + 大模型生成」。

## 升级到大模型生成（可选）

在同一终端设置环境变量后重启即可，无需改代码：

```powershell
$env:KB_LLM_API_KEY = "你的 DeepSeek API Key"
python -m uvicorn app.main:app --port 8000
```

可选变量：

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `KB_LLM_API_KEY` | 无（也可用 `DEEPSEEK_API_KEY`） | 模型 API Key |
| `KB_LLM_MODEL` | `deepseek-chat` | 模型名称 |
| `KB_LLM_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容接口地址 |
| `KB_DOCS_DIR` | `./data` | 知识库文档目录 |

换成你自己的资料：把 `.md` 文件放进 `data/`，然后重启，或调用 `POST /api/reload`。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 前端页面 |
| GET | `/api/health` | 服务状态、当前模式、文档与分块数 |
| POST | `/api/chat` | 提问，body：`{"question": "..."}` |
| POST | `/api/reload` | 重新加载 `data/` 文档 |

`/api/chat` 返回：`answer`（答案）、`mode`（`offline` 或 `rag`）、`sources`（引用片段：文档、相关度、摘录）。

## 测试

检索核心只依赖标准库，不需要安装包即可运行：

```powershell
python -m unittest discover -s tests -v
```

## 设计说明

- 分块：按段落聚合，约 400 字一块、块间少量重叠，超长段落按句读边界切分。
- 分词：优先 jieba；未安装时自动退化为「字符 + 相邻双字」，保证离线核心只依赖标准库。
- 检索：BM25（k1=1.5，b=0.75），返回得分最高的前 3 个片段。
- 引用：答案下方展示来源文档、相关度与命中摘录，方便核对。
- 无自动降级：配置了 Key 但调用失败时，接口会明确返回失败原因，而不是静默假装成功。
