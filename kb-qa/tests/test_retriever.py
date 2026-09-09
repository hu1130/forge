"""检索核心逻辑测试（仅依赖 Python 标准库，无需安装 fastapi）。"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app import retriever  # noqa: E402


class TokenizeTests(unittest.TestCase):
    def test_chinese_produces_tokens(self):
        tokens = retriever.tokenize("新能源汽车的续航里程怎么样")
        self.assertTrue(tokens)

    def test_ascii_word_kept(self):
        tokens = retriever.tokenize("FastAPI 与 RAG 的关系")
        lowered = {t.lower() for t in tokens}
        self.assertTrue("fastapi" in lowered or "rag" in lowered)


class RetrieverTests(unittest.TestCase):
    DOC_A = "苹果公司每年发布新款手机，手机的操作系统名为 iOS，适合开发移动应用。"
    DOC_B = "电动汽车依赖动力电池提供能量，续航里程是衡量用车体验的重要指标。"

    def setUp(self):
        self.r = retriever.Retriever()
        self.r.add_document("phone", self.DOC_A, name="手机.md")
        self.r.add_document("ev", self.DOC_B, name="电动汽车.md")
        self.r.rebuild_index()

    def test_relevant_doc_ranks_first(self):
        hits = self.r.search("电池续航怎么样", top_k=2)
        self.assertTrue(hits)
        self.assertEqual(hits[0].doc_id, "ev")

    def test_other_query_ranks_first(self):
        hits = self.r.search("手机系统发布", top_k=2)
        self.assertTrue(hits)
        self.assertEqual(hits[0].doc_id, "phone")

    def test_no_match_returns_empty(self):
        hits = self.r.search("宇宙飞船与量子计算", top_k=3)
        self.assertEqual(hits, [])

    def test_empty_query_returns_empty(self):
        self.assertEqual(self.r.search("   "), [])


class ChunkingAndPresentationTests(unittest.TestCase):
    def test_split_respects_size_cap(self):
        text = "很长的一段文字。" * 200  # 约 1600 字符
        chunks = retriever.split_text(text, max_chars=400, overlap=60)
        self.assertTrue(len(chunks) > 1)
        for chunk in chunks:
            self.assertLessEqual(len(chunk), 430)
        # 带重叠的分块不应丢失内容（总长度应不短于原文，且相邻块首应落在上一块尾部）
        self.assertGreaterEqual(sum(len(c) for c in chunks), len(text))
        self.assertIn(chunks[1][:20], chunks[0])

    def test_make_excerpt_contains_hit(self):
        text = "新能源汽车的动力电池管理系统负责监控温度与电压，保障充放电安全。" * 5
        excerpt = retriever.make_excerpt(text, ["电池"], limit=80)
        self.assertIn("电池", excerpt)
        self.assertLessEqual(len(excerpt), 90)

    def test_offline_answer_picks_related_sentence(self):
        text = (
            "第一句话与问题无关。\n"
            "新能源汽车的续航里程受电池容量和驾驶习惯影响。\n"
            "第三句继续无关内容。"
        )
        answer = retriever.offline_answer(text, ["续航", "电池"])
        self.assertIn("续航", answer)


class SampleDataTests(unittest.TestCase):
    def test_sample_directory_loads_and_searches(self):
        r = retriever.Retriever()
        added = r.add_directory(PROJECT_ROOT / "data")
        r.rebuild_index()
        self.assertGreater(added, 0)
        self.assertEqual(r.doc_count, 1)
        hits = r.search("RAG 的完整流程是什么", top_k=3)
        self.assertTrue(hits)
        self.assertIn("RAG", hits[0].chunk_text)


if __name__ == "__main__":
    unittest.main()
