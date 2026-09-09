"""轻量本地检索：文档分块 + 中文分词 + BM25。

设计目标（对应 1A 方案）：
- 不配置任何大模型 Key 也能完整离线演示；
- 分词优先使用 jieba；若 jieba 不可用，自动退化为「字符 + 相邻双字」
  tokenizer，保证核心检索逻辑只依赖 Python 标准库；
- 返回按相关性排序的片段与评分，供前端展示引用来源。
"""

from __future__ import annotations

import math
import os
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

try:  # jieba 是可选增强；缺失时使用内置退化分词
    import jieba

    _HAS_JIEBA = True
except Exception:  # pragma: no cover
    jieba = None
    _HAS_JIEBA = False

_CJK = re.compile(r"[\u4e00-\u9fff]")
_ASCII_WORD = re.compile(r"[a-zA-Z0-9]+")
_SPLIT = re.compile(r"[\s，。；：、,.!?！？;:()（）\[\]【】\"'“”‘’…—\-_/\\|]+")
_SENT_END = re.compile(r"(?<=[。！？!?；;])")

# 常见中文停用词（jieba 分词模式下过滤）
_STOPWORDS = {
    "的", "了", "在", "是", "和", "与", "及", "或", "一个", "我们", "你们",
    "他们", "它们", "可以", "要", "会", "能", "能够", "这", "那", "这些",
    "那些", "有", "对", "把", "被", "就", "都", "而", "并", "等", "为",
    "其", "之", "也", "很", "让", "从", "到", "用", "给", "上", "下", "中",
    "里", "个", "不", "没", "没有", "该", "已", "将", "着",
}


def tokenize(text: str) -> List[str]:
    """把文本切成检索 token。分词模式查询与文档保持一致即可。"""
    if not text:
        return []
    if _HAS_JIEBA:
        words = [w.strip().lower() for w in jieba.cut(text) if w and w.strip()]
        words = [
            w
            for w in words
            if len(w) > 1 or _CJK.fullmatch(w) or _ASCII_WORD.fullmatch(w)
        ]
        return [w for w in words if w not in _STOPWORDS]
    return _fallback_tokens(text)


def _fallback_tokens(text: str) -> List[str]:
    tokens: List[str] = []
    for seg in _SPLIT.split(text):
        if not seg:
            continue
        if seg.isascii() and seg.isalnum():
            tokens.append(seg.lower())
            continue
        chars = [c for c in seg if _CJK.match(c)]
        if len(chars) < 2:
            continue
        for i in range(len(chars) - 1):
            tokens.append(chars[i] + chars[i + 1])
    return tokens


def split_text(
    text: str, max_chars: int = 400, overlap: int = 60
) -> List[str]:
    """按段落聚合成块；超长段落按标点边界硬切，带少量重叠。"""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: List[str] = []
    buf = ""

    def flush() -> None:
        nonlocal buf
        if buf:
            chunks.append(buf)
            buf = ""

    for para in paragraphs:
        if len(para) <= max_chars:
            if buf and len(buf) + 1 + len(para) > max_chars:
                flush()
            buf = f"{buf}\n{para}".strip() if buf else para
            continue
        flush()
        start = 0
        while start < len(para):
            end = min(start + max_chars, len(para))
            if end < len(para):
                cut = max(
                    para.rfind("。", start, end),
                    para.rfind("？", start, end),
                    para.rfind("！", start, end),
                    para.rfind("；", start, end),
                    para.rfind("，", start, end),
                )
                if cut > start + max_chars // 2:
                    end = cut + 1
            piece = para[start:end].strip()
            if piece:
                chunks.append(piece)
            if end >= len(para):
                break
            start = max(end - overlap, start + 1)
    flush()
    return chunks


def make_excerpt(
    chunk_text: str, query_tokens: Sequence[str], limit: int = 240
) -> str:
    """把命中片段压缩成适合展示的引用文字。"""
    flat = re.sub(r"\s+", " ", chunk_text).strip()
    if len(flat) <= limit:
        return flat
    pos = -1
    for tok in query_tokens:
        if not tok:
            continue
        idx = flat.find(tok)
        if idx >= 0 and (pos < 0 or idx < pos):
            pos = idx
    if pos < 0:
        return flat[: limit - 1] + "…"
    start = max(0, pos - limit // 3)
    end = min(len(flat), start + limit)
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(flat) else ""
    return prefix + flat[start:end] + suffix


def offline_answer(chunk_text: str, query_tokens: Sequence[str]) -> str:
    """离线模式下从最相关片段提取“直接可读”的答案文字。"""
    lines = [ln.strip() for ln in chunk_text.splitlines() if ln.strip()]
    sentences: List[str] = []
    for ln in lines:
        if ln.startswith("#"):
            sentences.append(re.sub(r"^#{1,6}\s*", "", ln).strip())
            continue
        for s in _SENT_END.split(ln):
            s = s.strip()
            if s:
                sentences.append(s)
    if not sentences:
        return make_excerpt(chunk_text, query_tokens, limit=400)
    qset = set(t for t in query_tokens if t)
    best_sent, best_hits = "", 0
    for sent in sentences:
        hits = sum(1 for t in qset if t in sent)
        if hits > best_hits:
            best_sent, best_hits = sent, hits
    if best_hits == 0:
        return make_excerpt(chunk_text, query_tokens, limit=400)
    return best_sent


@dataclass
class Chunk:
    doc_id: str
    index: int
    text: str
    tokens: List[str] = field(default_factory=list)


@dataclass
class Hit:
    doc_id: str
    chunk_index: int
    score: float
    chunk_text: str


class Retriever:
    """分块 + BM25 的本地检索器。"""

    def __init__(self, k1: float = 1.5, b: float = 0.75) -> None:
        self.k1 = k1
        self.b = b
        self.chunks: List[Chunk] = []
        self.doc_names: Dict[str, str] = {}
        self._postings: Dict[str, List[Tuple[int, int]]] = {}
        self._df: Counter = Counter()
        self._avgdl = 0.0
        self._n = 0

    def add_document(
        self, doc_id: str, text: str, name: Optional[str] = None
    ) -> int:
        doc_id = str(doc_id)
        self.doc_names[doc_id] = name or doc_id
        parts = split_text(text)
        for i, part in enumerate(parts):
            self.chunks.append(
                Chunk(doc_id=doc_id, index=i, text=part, tokens=tokenize(part))
            )
        return len(parts)

    def add_directory(
        self, directory: str | os.PathLike, pattern: str = "*.md"
    ) -> int:
        """读取目录下文本文件作为知识库，返回新增块数。"""
        path = Path(directory)
        total = 0
        for file in sorted(path.glob(pattern)):
            try:
                text = file.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            total += self.add_document(file.stem, text, name=file.name)
        return total

    def rebuild_index(self) -> None:
        postings: Dict[str, List[Tuple[int, int]]] = defaultdict(list)
        df: Counter = Counter()
        total_len = 0
        for idx, chunk in enumerate(self.chunks):
            tfs = Counter(chunk.tokens)
            total_len += len(chunk.tokens)
            for tok, tf in tfs.items():
                postings[tok].append((idx, tf))
                df[tok] += 1
        self._postings = dict(postings)
        self._df = df
        self._n = len(self.chunks)
        self._avgdl = total_len / self._n if self._n else 0.0

    def search(self, query: str, top_k: int = 3) -> List[Hit]:
        query_tokens = tokenize(query)
        if not query_tokens or not self._n:
            return []
        scores: Dict[int, float] = defaultdict(float)
        qtf = Counter(query_tokens)
        for tok, qf in qtf.items():
            postings = self._postings.get(tok)
            if not postings:
                continue
            n = self._n
            df = self._df[tok]
            idf = math.log(1 + (n - df + 0.5) / (df + 0.5))
            for chunk_idx, tf in postings:
                chunk = self.chunks[chunk_idx]
                dl = max(len(chunk.tokens), 1)
                denom = tf + self.k1 * (
                    1 - self.b + self.b * dl / max(self._avgdl, 1e-6)
                )
                scores[chunk_idx] += idf * qf * (tf * (self.k1 + 1)) / denom
        ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
        hits: List[Hit] = []
        for chunk_idx, score in ranked[:top_k]:
            if score <= 0:
                continue
            chunk = self.chunks[chunk_idx]
            hits.append(
                Hit(
                    doc_id=chunk.doc_id,
                    chunk_index=chunk.index,
                    score=round(float(score), 4),
                    chunk_text=chunk.text,
                )
            )
        return hits

    @property
    def doc_count(self) -> int:
        return len(self.doc_names)

    @property
    def chunk_count(self) -> int:
        return len(self.chunks)

    def describe(self) -> Dict[str, object]:
        return {
            "tokenizer": "jieba" if _HAS_JIEBA else "fallback(char+bigram)",
            "documents": self.doc_count,
            "chunks": self.chunk_count,
        }
