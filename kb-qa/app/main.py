"""FastAPI 知识库问答服务（方案 2A：直接托管单个静态前端页面）。"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from . import llm, retriever

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA_DIR = Path(os.environ.get("KB_DOCS_DIR", ROOT / "data"))
DEFAULT_STATIC_DIR = ROOT / "static"

kb = retriever.Retriever()


def load_knowledge_base() -> dict:
    kb.chunks.clear()
    kb.doc_names.clear()
    added = kb.add_directory(DEFAULT_DATA_DIR)
    kb.rebuild_index()
    return {"loaded_documents": kb.doc_count, "added_chunks": added}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    load_knowledge_base()
    yield


app = FastAPI(
    title="知识库问答",
    description="离线可跑的本地知识库问答；配置大模型 Key 后自动升级为“检索 + 生成”。",
    version="0.1.0",
    lifespan=lifespan,
)


def _mode() -> str:
    return "rag" if llm.is_configured() else "offline"


def _sources(hits: list[retriever.Hit], question: str) -> list[dict]:
    tokens = retriever.tokenize(question)
    return [
        {
            "doc": kb.doc_names.get(h.doc_id, h.doc_id),
            "score": h.score,
            "excerpt": retriever.make_excerpt(h.chunk_text, tokens),
        }
        for h in hits
    ]


class ChatRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=2000, description="用户问题")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(DEFAULT_STATIC_DIR / "index.html")


@app.get("/api/health")
def health() -> dict:
    info = kb.describe()
    return {
        "ok": True,
        "mode": _mode(),
        "llm_configured": llm.is_configured(),
        **info,
    }


@app.post("/api/reload")
def reload_kb() -> dict:
    result = load_knowledge_base()
    return {"ok": True, "mode": _mode(), **result}


@app.post("/api/chat")
def chat(req: ChatRequest) -> dict:
    question = req.question.strip()
    if not question:
        return JSONResponse(status_code=400, content={"ok": False, "error": "问题不能为空"})

    hits = kb.search(question, top_k=3)
    sources = _sources(hits, question)
    mode = _mode()

    if not hits:
        return {
            "ok": True,
            "mode": mode,
            "answer": "资料库中没有找到与这个问题相关的内容。可以换个问法，或补充知识库文档。",
            "sources": [],
        }

    context = "\n\n".join(
        f"[资料{i + 1}] {kb.doc_names.get(h.doc_id, h.doc_id)}：{h.chunk_text}"
        for i, h in enumerate(hits)
    )
    top = hits[0]

    if mode == "rag":
        try:
            answer = llm.chat(question, context)
        except llm.LLMError as exc:
            answer = (
                f"已检索到相关资料，但调用大模型失败：{exc}\n"
                "可检查 API Key 与网络后重试；下方引用片段仍可用于离线参考。"
            )
    else:
        tokens = retriever.tokenize(question)
        answer = retriever.offline_answer(top.chunk_text, tokens)

    return {
        "ok": True,
        "mode": mode,
        "answer": answer,
        "sources": sources,
    }
