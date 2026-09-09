import { randomUUID } from "node:crypto";
import path from "node:path";
import { EventEmitter } from "node:events";
import * as pty from "node-pty";
import type { TerminalSession, TerminalStreamEvent } from "@forge/contracts";

export interface ManagedTerminal {
  info: TerminalSession;
  process: pty.IPty;
  events: EventEmitter;
  buffer: string;
}

const MAX_BUFFER_LENGTH = 128 * 1024;

export class TerminalManager {
  private readonly sessions = new Map<string, ManagedTerminal>();
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  list() {
    return [...this.sessions.values()].map(({ info }) => ({ ...info }));
  }

  setWorkspaceRoot(workspaceRoot: string) {
    this.close();
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  create(requestedCwd?: string) {
    const cwd = this.safeCwd(requestedCwd);
    const shell = process.env.FORGE_SHELL?.trim() || "powershell.exe";
    const id = randomUUID();
    const info: TerminalSession = {
      id,
      title: `PowerShell ${this.sessions.size + 1}`,
      cwd,
      shell,
      status: "running",
      createdAt: new Date().toISOString(),
    };
    const terminalProcess = pty.spawn(shell, ["-NoLogo", "-NoProfile"], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd,
      env: process.env as Record<string, string>,
      useConpty: true,
    });
    const managed: ManagedTerminal = { info, process: terminalProcess, events: new EventEmitter(), buffer: "" };
    this.sessions.set(id, managed);
    terminalProcess.onData((data) => {
      managed.buffer = `${managed.buffer}${data}`.slice(-MAX_BUFFER_LENGTH);
      managed.events.emit("event", { type: "data", data } satisfies TerminalStreamEvent);
    });
    terminalProcess.onExit(({ exitCode }) => {
      managed.info = { ...managed.info, status: "exited", exitCode };
      managed.events.emit("event", { type: "exit", exitCode } satisfies TerminalStreamEvent);
    });
    return { ...info };
  }

  find(id: string) {
    return this.sessions.get(id);
  }

  write(id: string, data: string) {
    const session = this.requireRunning(id);
    session.process.write(data);
  }

  resize(id: string, cols: number, rows: number) {
    const session = this.requireRunning(id);
    session.process.resize(Math.max(20, Math.min(400, Math.floor(cols))), Math.max(5, Math.min(200, Math.floor(rows))));
  }

  kill(id: string) {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.info.status === "running") session.process.kill();
    this.sessions.delete(id);
    session.events.removeAllListeners();
    return true;
  }

  close() {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }

  private requireRunning(id: string) {
    const session = this.sessions.get(id);
    if (!session || session.info.status !== "running") throw new Error("终端不存在或已经退出");
    return session;
  }

  private safeCwd(requestedCwd?: string) {
    const resolved = path.resolve(requestedCwd || this.workspaceRoot);
    const relative = path.relative(this.workspaceRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("终端工作目录必须位于当前工作区内");
    return resolved;
  }
}
