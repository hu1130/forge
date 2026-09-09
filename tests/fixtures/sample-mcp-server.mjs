import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "initialize") {
    send(message.id, {
      protocolVersion: message.params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "forge-sample", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    send(message.id, {
      tools: [{
        name: "echo",
        title: "Echo",
        description: "Returns the provided text.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      }],
    });
    return;
  }
  if (message.method === "tools/call") {
    send(message.id, { content: [{ type: "text", text: String(message.params?.arguments?.text || "") }] });
    return;
  }
  if (message.id !== undefined) send(message.id, {});
});
