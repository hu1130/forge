import { useEffect, useRef, useState } from "react";
import { Check, FileCode2, LoaderCircle, Search, X } from "lucide-react";
import type { WorkspaceFileInfo, WorkspaceFilesPayload } from "@forge/contracts";

const MAX_CONTEXT_FILES = 20;

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ContextFilePicker({ selected, onChange, onClose }: {
  selected: WorkspaceFileInfo[];
  onChange: (files: WorkspaceFileInfo[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WorkspaceFileInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const selectedPaths = new Set(selected.map((file) => file.path));

  useEffect(() => {
    searchRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(`/api/workspace/files?query=${encodeURIComponent(query.trim())}`, { signal: controller.signal });
        const payload = await response.json() as WorkspaceFilesPayload & { message?: string };
        if (!response.ok) throw new Error(payload.message || "无法读取工作区文件");
        setResults(payload.files);
        setTruncated(payload.truncated);
      } catch (reason) {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const toggleFile = (file: WorkspaceFileInfo) => {
    if (selectedPaths.has(file.path)) {
      onChange(selected.filter((item) => item.path !== file.path));
      return;
    }
    if (selected.length < MAX_CONTEXT_FILES) onChange([...selected, file]);
  };

  return <section id="context-file-picker" className="context-file-picker" role="dialog" aria-labelledby="context-file-picker-title">
    <header>
      <div><strong id="context-file-picker-title">添加上下文文件</strong><span>{selected.length}/{MAX_CONTEXT_FILES}</span></div>
      <button type="button" aria-label="关闭文件选择" onClick={onClose}><X size={15} /></button>
    </header>
    <label className="context-file-search">
      <span className="sr-only">搜索当前工作区文件</span>
      <Search size={15} />
      <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按文件名或路径搜索" />
    </label>
    <div className="context-file-results">
      {loading ? <div className="context-file-state"><LoaderCircle className="spin" size={15} />正在读取工作区…</div>
        : error ? <div className="context-file-state context-file-error">{error}</div>
          : results.length ? results.map((file) => {
            const isSelected = selectedPaths.has(file.path);
            const disabled = !isSelected && selected.length >= MAX_CONTEXT_FILES;
            return <button key={file.path} type="button" className={isSelected ? "selected" : ""} aria-pressed={isSelected} disabled={disabled} title={file.path} onClick={() => toggleFile(file)}>
              <span className="context-file-check">{isSelected && <Check size={12} />}</span>
              <FileCode2 size={16} />
              <span className="context-file-copy"><strong>{file.name}</strong><small>{file.path}</small></span>
              <em>{formatFileSize(file.size)}</em>
            </button>;
          }) : <div className="context-file-state">没有匹配的可附加文件</div>}
    </div>
    <footer>{truncated ? "结果较多，请继续输入以缩小范围。" : "仅列出普通文件；疑似密钥和生成目录已隐藏。"}</footer>
  </section>;
}
