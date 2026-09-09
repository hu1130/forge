import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalSession, TerminalStreamEvent } from "@forge/contracts";

export default function TerminalPanel({ workspacePath }: { workspacePath: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    let terminalId = "";
    let eventSource: EventSource | null = null;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"Cascadia Code", Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      theme: { background: "#171815", foreground: "#d7dad2", cursor: "#d7dad2", green: "#67bf8b", red: "#dc7d78", blue: "#7fa4ff" },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);

    const sendResize = () => {
      if (disposed) return;
      fitAddon.fit();
      if (terminalId) {
        void fetch(`/api/terminals/${terminalId}/resize`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cols: terminal.cols, rows: terminal.rows }),
        });
      }
    };
    const resizeObserver = new ResizeObserver(sendResize);
    resizeObserver.observe(containerRef.current);
    const inputDisposable = terminal.onData((data) => {
      if (!terminalId) return;
      void fetch(`/api/terminals/${terminalId}/input`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data }),
      }).catch(() => setError("终端输入发送失败"));
    });

    const connect = async () => {
      const listedResponse = await fetch("/api/terminals");
      if (!listedResponse.ok) throw new Error("无法读取终端列表");
      const listed = await listedResponse.json() as { terminals: TerminalSession[] };
      let active = listed.terminals.find((item) => item.status === "running");
      if (!active) {
        const createdResponse = await fetch("/api/terminals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd: workspacePath }),
        });
        if (!createdResponse.ok) {
          const payload = await createdResponse.json() as { message?: string };
          throw new Error(payload.message || "无法创建终端");
        }
        active = await createdResponse.json() as TerminalSession;
      }
      if (disposed) return;
      terminalId = active.id;
      setSession(active);
      sendResize();
      eventSource = new EventSource(`/api/terminals/${active.id}/stream`);
      eventSource.onmessage = (event) => {
        const payload = JSON.parse(event.data) as TerminalStreamEvent;
        if (payload.type === "data") terminal.write(payload.data);
        if (payload.type === "exit") {
          terminal.write(`\r\n\x1b[90m[终端已退出，代码 ${payload.exitCode}]\x1b[0m\r\n`);
          setSession((current) => current ? { ...current, status: "exited", exitCode: payload.exitCode } : current);
        }
      };
    };

    void connect().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      disposed = true;
      eventSource?.close();
      inputDisposable.dispose();
      resizeObserver.disconnect();
      terminal.dispose();
    };
  }, [generation, workspacePath]);

  const restart = async () => {
    if (session) await fetch(`/api/terminals/${session.id}`, { method: "DELETE" }).catch(() => undefined);
    setSession(null);
    setError("");
    setGeneration((value) => value + 1);
  };

  return <div className="terminal-panel">
    <div className="terminal-toolbar">
      <span className={`terminal-status terminal-${session?.status || "starting"}`} />
      <strong>{session?.title || "正在启动 PowerShell"}</strong>
      <span title={session?.cwd}>{session?.cwd || workspacePath}</span>
      <button type="button" onClick={() => void restart()}>{session?.status === "exited" ? "重新打开" : "重启"}</button>
    </div>
    {error && <div className="terminal-error" role="alert">{error}</div>}
    <div className="terminal-surface" ref={containerRef} aria-label="PowerShell 终端" />
  </div>;
}
