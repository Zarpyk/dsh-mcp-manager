import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { probeServer } from "../lib/probe.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_STDIO = path.join(here, "fake-stdio-server.mjs");

const tools = [
  { name: "echo", description: "Echo the input back." },
  { name: "add", description: "Add two numbers." },
];

function initializeResult(version = "2025-06-18") {
  return {
    protocolVersion: version,
    capabilities: { tools: {} },
    serverInfo: { name: "fake-http-server", version: "0.2.0" },
    instructions: "Use these tools.",
  };
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

test("probeServer completes the handshake with a stdio server", async () => {
  const probe = await probeServer({ transport: "stdio", command: process.execPath, args: [FAKE_STDIO] }, { timeoutMs: 15000 });
  assert.equal(probe.ok, true, probe.error);
  assert.equal(probe.serverName, "fake-server");
  assert.equal(probe.serverVersion, "0.1.0");
  assert.equal(probe.protocolVersion, "2025-06-18");
  assert.equal(probe.toolCount, 2);
  assert.deepEqual(probe.tools.map((tool) => tool.name), ["echo", "add"]);
  assert.ok(probe.ms >= 0);
});

test("probeServer reports a missing stdio command with a hint", async () => {
  const probe = await probeServer({ transport: "stdio", command: "definitely-not-a-real-mcp-command" }, { timeoutMs: 5000 });
  assert.equal(probe.ok, false);
  assert.ok(probe.error);
  assert.ok(probe.hint, "expected a hint for the operator");
});

test("probeServer talks to a streamable HTTP server that answers JSON and SSE", async () => {
  const { server, origin } = await listen(async (request, response) => {
    const body = await readBody(request);
    if (body.method === "initialize") {
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: initializeResult() }));
      return;
    }
    if (body.method === "tools/list") {
      assert.equal(request.headers["mcp-session-id"], "sess-1");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools } })}\n\n`);
      return;
    }
    response.writeHead(202);
    response.end();
  });

  try {
    const probe = await probeServer({ transport: "http", url: `${origin}/mcp` }, { timeoutMs: 8000 });
    assert.equal(probe.ok, true, probe.error);
    assert.equal(probe.serverName, "fake-http-server");
    assert.equal(probe.toolCount, 2);
    assert.deepEqual(probe.capabilities, ["tools"]);
  } finally {
    await close(server);
  }
});

test("probeServer retries the next protocol version when the server rejects one", async () => {
  let attempts = 0;
  const { server, origin } = await listen(async (request, response) => {
    const body = await readBody(request);
    attempts += 1;
    if (body.method === "initialize" && body.params?.protocolVersion === "2025-06-18") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32600, message: "Unsupported protocol version" } }));
      return;
    }
    if (body.method === "initialize") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: initializeResult("2025-03-26") }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools } }));
  });

  try {
    const probe = await probeServer({ transport: "http", url: `${origin}/mcp` }, { timeoutMs: 8000 });
    assert.equal(probe.ok, true, probe.error);
    assert.equal(probe.protocolVersion, "2025-03-26");
    assert.ok(attempts >= 3, "expected an initialize retry");
  } finally {
    await close(server);
  }
});

test("probeServer explains an authentication failure", async () => {
  const { server, origin } = await listen((request, response) => {
    response.writeHead(401, { "content-type": "text/plain" });
    response.end("unauthorized");
  });

  try {
    const probe = await probeServer({ transport: "http", url: `${origin}/mcp` }, { timeoutMs: 5000 });
    assert.equal(probe.ok, false);
    assert.match(probe.error, /401/);
    assert.match(probe.hint, /Authorization header/i);
  } finally {
    await close(server);
  }
});

test("probeServer supports the legacy SSE transport", async () => {
  let stream;
  const { server, origin } = await listen(async (request, response) => {
    if (request.method === "GET" && request.url === "/sse") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      stream = response;
      response.write("event: endpoint\ndata: /messages\n\n");
      return;
    }
    if (request.method === "POST" && request.url === "/messages") {
      const body = await readBody(request);
      response.writeHead(202);
      response.end("accepted");
      if (body.method === "initialize") {
        stream.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: initializeResult() })}\n\n`);
      } else if (body.method === "tools/list") {
        stream.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools } })}\n\n`);
      }
      return;
    }
    response.writeHead(404);
    response.end();
  });

  try {
    const probe = await probeServer({ transport: "sse", url: `${origin}/sse` }, { timeoutMs: 8000 });
    assert.equal(probe.ok, true, probe.error);
    assert.equal(probe.toolCount, 2);
  } finally {
    stream?.end();
    await close(server);
  }
});

test("probeServer times out instead of hanging", async () => {
  const { server, origin } = await listen(() => {
    /* never answers */
  });

  try {
    const probe = await probeServer({ transport: "http", url: `${origin}/mcp` }, { timeoutMs: 1000 });
    assert.equal(probe.ok, false);
    assert.ok(probe.error);
  } finally {
    await close(server);
  }
});
