import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const TIMEOUT_MS = 10_000;

const child = spawn("codex", ["app-server", "--stdio"], {
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let settled = false;
let stderr = "";

const finish = (code, detail) => {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  child.kill();
  process.stdout.write(`${JSON.stringify(detail)}\n`);
  process.exitCode = code;
};

const timeout = setTimeout(() => {
  finish(1, {
    status: "failed",
    stage: "initialize",
    reason: `No initialize response within ${TIMEOUT_MS}ms`,
  });
}, TIMEOUT_MS);

child.on("error", (error) => {
  finish(1, {
    status: "failed",
    stage: "spawn",
    reason: error.message,
  });
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
  if (stderr.length > 2_000) stderr = stderr.slice(-2_000);
});

const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    finish(1, {
      status: "failed",
      stage: "parse",
      reason: "App Server emitted non-JSON stdout",
    });
    return;
  }

  if (message.id !== 1) return;

  if (message.error) {
    finish(1, {
      status: "failed",
      stage: "initialize",
      reason: message.error.message ?? "Unknown App Server error",
    });
    return;
  }

  child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  finish(0, {
    status: "passed",
    transport: "stdio-jsonl",
    handshake: ["initialize", "initialized"],
    serverInfoPresent: Boolean(message.result),
  });
});

child.stdin.write(
  `${JSON.stringify({
    method: "initialize",
    id: 1,
    params: {
      clientInfo: {
        name: "local_codex_like_p0_probe",
        title: "Local Codex-like P0 Probe",
        version: "0.0.0",
      },
    },
  })}\n`,
);

