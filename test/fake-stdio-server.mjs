#!/usr/bin/env node
// Minimal MCP server over stdio: answers initialize and tools/list.
// Set FAKE_EMPTY=1 to mimic servers (Unity and friends) that publish nothing until their host app connects.
const EMPTY = process.env.FAKE_EMPTY === "1";
let buffer = "";
process.stderr.write(`fake-mcp-server started${EMPTY ? " (no tools)" : ""}\n`);

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-server", version: "0.1.0" },
          instructions: "A fake server used by the test suite.",
        },
      });
    } else if (message.method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: EMPTY
            ? []
            : [
                {
                  name: "echo",
                  title: "Echo",
                  description: "Echo the input back.",
                  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
                },
                {
                  name: "add",
                  title: "Add",
                  description: "Add two numbers.",
                  inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
                },
              ],
        },
      });
    } else if (message.method === "tools/call") {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      if (name === "echo") {
        send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: String(args.text ?? "") }] } });
      } else if (name === "add") {
        send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: String(Number(args.a ?? 0) + Number(args.b ?? 0)) }] } });
      } else {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `unknown tool ${name}` } });
      }
    } else if (message.method === "notifications/initialized") {
      // no reply
    } else if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
    }
  }
});
