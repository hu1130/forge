import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import type { RuntimePhase } from "@forge/contracts";

export interface RpcMessage {
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string };
  method?: string;
  params?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class CodexBridge extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private phase: RuntimePhase = "starting";
  private detail = "正在启动 Codex App Server";
  private startPromise: Promise<void> | null = null;

  constructor(private appServerArgs: string[] = []) {
    super();
  }

  status() {
    return { phase: this.phase, detail: this.detail };
  }

  async start() {
    if (this.phase === "ready" && this.process) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startProcess();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startProcess() {
    if (this.process) return;
    this.phase = "starting";
    this.detail = "正在启动 Codex App Server";
    const executable = process.env.FORGE_CODEX_BIN || "codex";
    const forgeDataDir = process.env.FORGE_DATA_DIR || path.join(os.homedir(), ".forge");
    const codexHome = path.resolve(process.env.FORGE_CODEX_HOME || path.join(forgeDataDir, "codex"));
    mkdirSync(codexHome, { recursive: true });
    try {
      const child = spawn(executable, ["app-server", "--stdio", ...this.appServerArgs], {
        env: { ...process.env, CODEX_HOME: codexHome },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.process = child;
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        if (this.process === child) this.handleLine(line);
      });
      child.stderr.on("data", (chunk) => {
        if (this.process !== child) return;
        const message = String(chunk).trim();
        if (message) this.detail = message.split("\n").at(-1) || message;
      });
      child.on("error", (error) => {
        if (this.process === child) this.markUnavailable(error.message);
      });
      child.on("exit", (code) => {
        if (this.process !== child) return;
        const startupDetail = this.phase === "starting" && this.detail !== "正在启动 Codex App Server" ? this.detail : undefined;
        this.markUnavailable(startupDetail || `App Server 已退出（${code ?? "unknown"}）`);
        this.process = null;
      });

      await this.request("initialize", {
        clientInfo: { name: "forge_local", title: "Forge", version: "0.2.0" },
      });
      this.notify("initialized", {});
      this.phase = "ready";
      this.detail = "stdio / JSONL 已连接";
      this.emit("status", this.status());
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.process?.kill();
      this.process = null;
      this.markUnavailable(failure.message);
      throw failure;
    }
  }

  request(method: string, params: unknown, timeoutMs = 8_000) {
    if (!this.process?.stdin.writable) return Promise.reject(new Error("App Server 未连接"));
    const id = ++this.requestId;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 请求超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process?.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method: string, params: unknown) {
    if (this.process?.stdin.writable) this.process.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  respond(id: number | string, result: unknown) {
    if (this.process?.stdin.writable) this.process.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  stop() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("App Server 已停止"));
    }
    this.pending.clear();
    const child = this.process;
    this.process = null;
    child?.kill();
  }

  async restart(appServerArgs: string[]) {
    this.appServerArgs = [...appServerArgs];
    this.stop();
    await this.start();
  }

  private handleLine(line: string) {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }
    if (message.method && message.id !== undefined) {
      this.emit("request", message);
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "App Server 请求失败"));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) this.emit("notification", message);
  }

  private markUnavailable(detail: string) {
    this.phase = "unavailable";
    this.detail = detail;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(detail));
    }
    this.pending.clear();
    this.emit("status", this.status());
  }
}
