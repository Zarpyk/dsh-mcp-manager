import assert from "node:assert/strict";
import test from "node:test";
import { describeSpec, detectTransport, extractEntries, maskValue, maskedSpec, normalizeEntry, parseToml, redactUrl, specHash } from "../lib/parse.js";

test("parseToml reads codex-style tables, arrays and inline tables", () => {
  const doc = parseToml(`
# a comment
model = "gpt-5"

[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "C:\\\\work"]  # trailing comment
startup_timeout_sec = 20

[mcp_servers.filesystem.env]
LOG_LEVEL = "debug"

[mcp_servers.remote]
url = "https://mcp.example.com/mcp"
http_headers = { Authorization = "Bearer abc", "X-Trace" = 'on' }

[[mcp_servers.list]]
command = "one"
[[mcp_servers.list]]
command = "two"
`);
  assert.equal(doc.model, "gpt-5");
  assert.equal(doc.mcp_servers.filesystem.command, "npx");
  assert.deepEqual(doc.mcp_servers.filesystem.args, ["-y", "@modelcontextprotocol/server-filesystem", "C:\\work"]);
  assert.equal(doc.mcp_servers.filesystem.startup_timeout_sec, 20);
  assert.equal(doc.mcp_servers.filesystem.env.LOG_LEVEL, "debug");
  assert.equal(doc.mcp_servers.remote.http_headers.Authorization, "Bearer abc");
  assert.equal(doc.mcp_servers.remote.http_headers["X-Trace"], "on");
  assert.deepEqual(doc.mcp_servers.list.map((item) => item.command), ["one", "two"]);
});

test("parseToml handles multi-line arrays", () => {
  const doc = parseToml(`[mcp_servers.slow]
command = "node"
args = [
  "server.js",
  "--port",
  "3000",
]
`);
  assert.deepEqual(doc.mcp_servers.slow.args, ["server.js", "--port", "3000"]);
});

test("extractEntries finds the server container in each dialect", () => {
  assert.deepEqual(
    extractEntries({ mcpServers: { a: { command: "x" } } }, "standard").map((item) => item.name),
    ["a"],
  );
  assert.deepEqual(
    extractEntries({ servers: { b: { url: "https://x" } } }, "vscode").map((item) => item.name),
    ["b"],
  );
  assert.deepEqual(
    extractEntries({ mcp: { servers: { c: { command: "y" } } } }, "gemini").map((item) => item.name),
    ["c"],
  );
  assert.deepEqual(
    extractEntries({ mcp_servers: { d: { command: "z" } } }, "codex").map((item) => item.name),
    ["d"],
  );
});

test("extractEntries reads the DSH connector storage table", () => {
  const doc = { tables: { connections: { one: { name: "github", server: { transport: { type: "stdio", command: "npx" } } } } } };
  const entries = extractEntries(doc, "connector");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "github");
});

test("normalizeEntry copes with every client dialect", () => {
  const standard = normalizeEntry("fs", { command: "npx", args: ["-y", "pkg"], env: { TOKEN: "abc" } }, "standard");
  assert.equal(standard.transport, "stdio");
  assert.equal(standard.command, "npx");
  assert.deepEqual(standard.args, ["-y", "pkg"]);

  const remote = normalizeEntry("remote", { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer t" } }, "standard");
  assert.equal(remote.transport, "http");
  assert.equal(remote.url, "https://mcp.example.com/mcp");

  const sse = normalizeEntry("events", { url: "https://x/sse", type: "sse" }, "standard");
  assert.equal(sse.transport, "sse");

  const opencode = normalizeEntry("local", { type: "local", command: ["node", "server.js"], environment: { A: "1" } }, "opencode");
  assert.equal(opencode.transport, "stdio");
  assert.equal(opencode.command, "node");
  assert.deepEqual(opencode.args, ["server.js"]);
  assert.deepEqual(opencode.env, { A: "1" });

  const zed = normalizeEntry("zed", { command: { path: "/usr/bin/uvx", args: ["mcp-server"], env: { K: "v" } } }, "zed");
  assert.equal(zed.command, "/usr/bin/uvx");
  assert.deepEqual(zed.args, ["mcp-server"]);

  const codex = normalizeEntry("remote", { url: "https://x/mcp", http_headers: { "X-Api-Key": "k" } }, "codex");
  assert.equal(codex.transport, "http");
  assert.deepEqual(codex.headers, { "X-Api-Key": "k" });

  const connector = normalizeEntry("c", { transport: { type: "stdio", command: "bun", args: ["x.js"] } }, "connector");
  assert.equal(connector.command, "bun");
  assert.deepEqual(connector.args, ["x.js"]);

  assert.equal(normalizeEntry("off", { command: "x", disabled: true }, "standard").enabled, false);
});

test("detectTransport prefers an explicit type and falls back to shape", () => {
  assert.equal(detectTransport("streamable-http", "", "https://x"), "http");
  assert.equal(detectTransport("", "npx", ""), "stdio");
  assert.equal(detectTransport("", "", "https://x"), "http");
  assert.equal(detectTransport("", "", ""), "unknown");
});

test("specHash changes only when the connection changes", () => {
  const base = { transport: "stdio", command: "npx", args: ["a"], env: { A: "1" }, cwd: "", url: "", headers: {}, enabled: true };
  assert.equal(specHash(base), specHash({ ...base, args: ["a"], env: { A: "1" } }));
  assert.notEqual(specHash(base), specHash({ ...base, args: ["b"] }));
  assert.notEqual(specHash(base), specHash({ ...base, enabled: false }));
});

test("secrets are masked for display but not for connection", () => {
  assert.equal(maskValue("abcdefghijkl"), "••••••ijkl");
  assert.equal(maskValue("short"), "••••••");
  const masked = maskedSpec({
    transport: "stdio",
    command: "npx",
    args: [],
    cwd: "",
    url: "https://mcp.example.com/mcp?api_key=supersecret&mode=full",
    env: { GITHUB_TOKEN: "ghp_1234567890", LOG_LEVEL: "debug" },
    headers: { Authorization: "Bearer 1234567890", "X-Trace": "abc" },
    enabled: true,
  });
  assert.equal(masked.env.GITHUB_TOKEN, "••••••7890");
  assert.equal(masked.env.LOG_LEVEL, "debug");
  assert.equal(masked.headers.Authorization, "••••••7890");
  assert.equal(masked.url, "https://mcp.example.com/mcp?api_key=***&mode=full");
});

test("redactUrl and describeSpec produce a short readable line", () => {
  assert.equal(redactUrl("https://user:pass@host/mcp?token=t"), "https://***:***@host/mcp?token=***");
  assert.equal(describeSpec({ transport: "stdio", command: "npx", args: ["-y", "pkg"] }), "npx -y pkg");
  assert.equal(describeSpec({ transport: "http", url: "https://mcp.example.com/mcp" }), "https://mcp.example.com/mcp");
});
