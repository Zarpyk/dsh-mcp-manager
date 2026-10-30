#!/usr/bin/env node
// Minimal MCP server over stdio: answers initialize and tools/list.
let buffer = "";
process.stderr.write("fake-mcp-server started\n");

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
          tools: [
            { name: "echo", description: "Echo the input back." },
            { name: "add", description: "Add two numbers." },
          ],
        },
      });
    } else if (message.method === "notifications/initialized") {
      // no reply
    } else if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
    }
  }
});
