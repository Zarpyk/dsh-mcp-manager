import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ExposureBridge, resultText, slug, toolNameFor } from "../lib/bridge.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeServer = path.join(here, "fake-stdio-server.mjs");

/** Minimal cordis-like context: only `tools.register` matters to the bridge. */
function makeContext() {
  const tools = new Map();
  return {
    tools,
    ctx: {
      tools: {
        register(definition) {
          if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
          tools.set(definition.name, definition);
          return () => tools.delete(definition.name);
        },
        get(name) {
          return tools.get(name);
        },
      },
    },
  };
}

function stdioEntry(overrides = {}) {
  return {
    id: "srv1",
    name: "Fake Server",
    enabled: true,
    expose: true,
    hash: "hash-1",
    spec: { transport: "stdio", command: process.execPath, args: [fakeServer] },
    ...overrides,
  };
}

test("slug and toolNameFor produce registry-safe names", () => {
  assert.equal(slug("Unity MCP!"), "unity_mcp");
  assert.equal(slug(""), "server");
  assert.equal(toolNameFor("Fake Server", "echo"), "mcp_fake_server_echo");
  const long = toolNameFor("a".repeat(80), "b".repeat(80));
  assert.ok(long.length <= 60);
});

test("resultText flattens MCP content blocks", () => {
  assert.equal(resultText({ content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }] }), "hello\nworld");
  assert.equal(resultText({ content: [{ type: "image", mimeType: "image/png" }] }), "[image image/png]");
  assert.equal(resultText("plain"), "plain");
});

test("an exposed stdio server registers its tools and answers calls", async () => {
  const { ctx, tools } = makeContext();
  const bridge = new ExposureBridge(ctx);
  try {
    await bridge.sync([stdioEntry()]);
    assert.deepEqual([...tools.keys()].sort(), ["mcp_fake_server_add", "mcp_fake_server_echo"]);
    assert.equal(bridge.status("srv1").state, "ready");

    const echo = tools.get("mcp_fake_server_echo");
    assert.equal(echo.parameters.type, "object");
    assert.equal(echo.parameters.properties.text.type, "string");
    const value = await echo.execute({ text: "ping" });
    assert.equal(resultText(value), "ping");

    const add = tools.get("mcp_fake_server_add");
    assert.equal(resultText(await add.execute({ a: 2, b: 40 })), "42");
  } finally {
    await bridge.stopAll();
  }
});

test("stopping exposure disposes every registered tool", async () => {
  const { ctx, tools } = makeContext();
  const bridge = new ExposureBridge(ctx);
  await bridge.sync([stdioEntry()]);
  assert.equal(tools.size, 2);

  await bridge.sync([stdioEntry({ expose: false })]);
  assert.equal(tools.size, 0);
  assert.equal(bridge.status("srv1").state, "off");
  await bridge.stopAll();
});

test("a spec change restarts the session and keeps tools registered", async () => {
  const { ctx, tools } = makeContext();
  const bridge = new ExposureBridge(ctx);
  await bridge.sync([stdioEntry()]);
  await bridge.sync([stdioEntry({ hash: "hash-2" })]);
  assert.equal(bridge.status("srv1").state, "ready");
  assert.equal(tools.size, 2);
  await bridge.stopAll();
});

test("a broken server records an error instead of throwing", async () => {
  const { ctx, tools } = makeContext();
  const bridge = new ExposureBridge(ctx);
  try {
    await bridge.sync([
      stdioEntry({ id: "bad", name: "Broken", spec: { transport: "stdio", command: "definitely-not-a-real-binary-xyz" } }),
    ]);
    assert.equal(bridge.status("bad").state, "error");
    assert.equal(tools.size, 0);
  } finally {
    await bridge.stopAll();
  }
});
