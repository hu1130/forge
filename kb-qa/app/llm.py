"""可选 LLM 升级层（OpenAI 兼容 Chat Completions，默认 DeepSeek）。

不配置 Key 时保持离线，不产生任何网络请求。使用 Python 标准库
urllib，避免为一次可选调用引入额外依赖。
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Optional


class LLMError(RuntimeError):
    pass


def _api_key() -> Optional[str]:
    return (
        os.environ.get("KB_LLM_API_KEY")
        or os.environ.get("DEEPSEEK_API_KEY")
        or None
    )


def is_configured() -> bool:
    return bool(_api_key())


def chat(question: str, context: str, timeout: int = 90) -> str:
    """携带检索上下文调用 LLM 生成答案。失败抛出 LLMError。"""
    key = _api_key()
    if not key:
        raise LLMError("未配置 API Key，请设置 KB_LLM_API_KEY 或 DEEPSEEK_API_KEY")
    base = (
        os.environ.get("KB_LLM_BASE_URL") or "https://api.deepseek.com"
    ).rstrip("/")
    model = os.environ.get("KB_LLM_MODEL") or "deepseek-chat"
    system = (
        "你是知识库问答助手。请只依据下面【资料】回答用户问题：\n"
        "1. 优先用自己的话概括，可适当引用原文；\n"
        "2. 资料不足以回答时，明确说“资料中没有找到相关内容”，不要编造；\n"
        "3. 回答保持简洁，中文输出。"
    )
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {
                "role": "user",
                "content": f"【资料】\n{context}\n\n【问题】\n{question}",
            },
        ],
        "temperature": 0.2,
        "stream": False,
    }
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            pass
        raise LLMError(f"HTTP {exc.code}: {detail or exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise LLMError(f"网络错误: {exc.reason}") from exc
    try:
        return body["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise LLMError(
            f"响应格式异常: {json.dumps(body, ensure_ascii=False)[:300]}"
        ) from exc
