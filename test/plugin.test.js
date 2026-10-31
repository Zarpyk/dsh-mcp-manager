import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { apply, inject, name } from "../lib/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_STDIO = path.join(here, "fake-stdio-server.mjs");
const BASE = "http://127.0.0.1:57256";
const API = "/api/dsh-mcp-manager";

function createCtx() {
  const routes = new Map();
  const tools = new Map();
  const commands = new Map();
  const ctx = {
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    commands: {
      register(definition) {
        commands.set(definition.name, definition);
        return () => commands.delete(definition.name);
      },
    },
    effect(callback) {
      const dispose = callback();
      return () => dispose?.();
    },
    get() {
      return undefined;
    },
    logger: () => null,
  };
  return { ctx, routes, tools, commands };
}

function setupSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-mcp-manager-test-"));
  const home = path.join(root, "home");
  const dshHome = path.join(root, "dsh");
  fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
  fs.mkdirSync(dshHome, { recursive: true });
  fs.writeFileSync(
    path.join(home, ".cursor", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        filesystem: { command: process.execPath, args: [FAKE_STDIO] },
        remote: { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer secret-token" } },
      },
    }),
    "utf8",
  );
  for (const key of ["DSH_HOME", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) process.env[key] = path.join(root, key.toLowerCase());
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.DSH_HOME = dshHome;
  return { root, home, dshHome };
}

async function callRoute(routes, method, action, body, options = {}) {
  const route = routes.get(`${API}/${action}`);
  assert.ok(route, `route ${action} was not registered`);
  const headers = {
    "x-dsh-mcp-manager": "1",
    "content-type": "application/json",
    origin: BASE,
    ...(options.headers ?? {}),
  };
  const request = new Request(`${BASE}${API}/${action}`, {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const response = await route.fetch(request);
  return { status: response.status, json: await response.json() };
}

async function waitFor(predicate, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

test("the plugin exports the cordis contract", () => {
  assert.equal(name, "mcp-manager");
  assert.deepEqual(inject, ["connection", "tools", "commands"]);
  assert.equal(typeof apply, "function");
});

test("state, save, probe, toggle, delete, restore and export round-trip", async (t) => {
  setupSandbox();
  const { ctx, routes, tools } = createCtx();
  apply(ctx, {});
  t.after(() => {
    for (const dispose of [...tools.values()].map((definition) => definition.dispose).filter(Boolean)) dispose();
  });

  assert.deepEqual([...routes.keys()].sort(), [`${API}/action`, `${API}/state`]);
  assert.deepEqual([...tools.keys()].sort(), ["mcp_export_config", "mcp_expose_server", "mcp_inventory", "mcp_probe", "mcp_remove_server", "mcp_save_server"]);

  const initial = await callRoute(routes, "GET", "state", undefined);
  assert.equal(initial.status, 200);
  assert.equal(initial.json.ok, true, initial.json.error);
  const discovered = initial.json.data.snapshot.servers;
  assert.equal(discovered.length, 2);
  assert.ok(discovered.every((server) => server.managed === false));
  assert.equal(discovered.find((server) => server.name === "remote").url, "https://mcp.example.com/mcp");
  assert.equal(discovered.find((server) => server.name === "filesystem").sourceApp, "Cursor");

  const saved = await callRoute(routes, "POST", "action", {
    action: "save",
    name: "pool-server",
    transport: "stdio",
    command: process.execPath,
    args: [FAKE_STDIO],
    note: "created by the test",
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.ok, true, saved.json.error);
  const managedKey = `managed:${saved.json.data.entry.id}`;
  assert.ok(saved.json.data.snapshot.servers.some((server) => server.key === managedKey && server.managed));

  const probed = await callRoute(routes, "POST", "action", { action: "probe", keys: [managedKey] });
  assert.equal(probed.json.ok, true, probed.json.error);
  assert.equal(probed.json.data.results[0].ok, true);
  const managed = probed.json.data.snapshot.servers.find((server) => server.key === managedKey);
  assert.equal(managed.probe.toolCount, 2);
  assert.equal(managed.probe.serverName, "fake-server");

  // Exposing the pool server must surface its tools on the harness registry.
  const exposed = await callRoute(routes, "POST", "action", { action: "set-expose", key: managedKey, exposed: true });
  assert.equal(exposed.json.ok, true, exposed.json.error);
  assert.ok(await waitFor(() => tools.has("mcp_pool_server_echo")), "bridge did not register the exposed tools");
  const echoTool = tools.get("mcp_pool_server_echo");
  const call = await echoTool.execute({ text: "bridge" });
  assert.equal(call.content[0].text, "bridge");
  const bridged = exposed.json.data.snapshot.servers.find((server) => server.key === managedKey);
  assert.equal(bridged.expose, true);

  const unexposed = await callRoute(routes, "POST", "action", { action: "set-expose", key: managedKey, exposed: false });
  assert.equal(unexposed.json.ok, true, unexposed.json.error);
  assert.ok(await waitFor(() => !tools.has("mcp_pool_server_echo")), "bridge did not release the exposed tools");

  const toggled = await callRoute(routes, "POST", "action", { action: "set-enabled", id: managedKey, enabled: false });
  assert.equal(toggled.json.ok, true);
  assert.equal(toggled.json.data.snapshot.servers.find((server) => server.key === managedKey).enabled, false);

  const exported = await callRoute(routes, "POST", "action", { action: "export", format: "json" });
  assert.equal(exported.json.ok, true);
  assert.ok(exported.json.data.text.includes("pool-server"));
  assert.ok(JSON.parse(exported.json.data.text).mcpServers["pool-server"]);

  const removed = await callRoute(routes, "POST", "action", { action: "delete", key: managedKey });
  assert.equal(removed.json.ok, true);
  assert.equal(removed.json.data.snapshot.servers.some((server) => server.key === managedKey), false);
  assert.ok(removed.json.data.snapshot.trash.some((entry) => entry.name === "pool-server"));

  const restored = await callRoute(routes, "POST", "action", { action: "restore", id: managedKey.replace("managed:", "") });
  assert.equal(restored.json.ok, true);
  assert.ok(restored.json.data.snapshot.servers.some((server) => server.key === managedKey));

  const emptied = await callRoute(routes, "POST", "action", { action: "empty-trash" });
  assert.equal(emptied.json.ok, true);
  assert.deepEqual(emptied.json.data.snapshot.trash, []);
});

test("/mcp command can expose a pool server without leaving the chat", async (t) => {
  setupSandbox();
  const { ctx, tools, commands } = createCtx();
  apply(ctx, {});
  t.after(() => {
    for (const dispose of [...tools.values()].map((definition) => definition.dispose).filter(Boolean)) dispose();
  });

  const command = commands.get("mcp");
  assert.ok(command, "/mcp was not registered");
  assert.equal(command.name, "mcp");

  const empty = await command.handler({ rawInput: "" });
  assert.equal(empty.kind, "success");
  assert.match(empty.text, /pool is empty/);

  await tools.get("mcp_save_server").execute({ name: "cmd-server", transport: "stdio", command: process.execPath, args: [FAKE_STDIO] });
  assert.ok(await waitFor(() => commands.has("mcp-cmd-server")), "the pool server did not get its own /mcp-<name> command");

  const listed = await command.handler({ rawInput: " list" });
  assert.equal(listed.kind, "success", listed.text);
  assert.match(listed.text, /cmd-server \[stdio\] enabled — not exposed/);

  const exposed = await command.handler({ rawInput: " cmd-server" });
  assert.equal(exposed.kind, "success", exposed.text);
  assert.match(exposed.text, /mcp_cmd_server_echo/);
  assert.ok(tools.has("mcp_cmd_server_echo"), "the command did not publish the server tools");

  const published = await command.handler({ rawInput: "tools cmd-server" });
  assert.match(published.text, /server tool: echo/);

  const generated = commands.get("mcp-cmd-server");
  assert.ok(generated, "the generated /mcp-cmd-server command is missing");
  assert.match(generated.description, /cmd-server/);

  const hiddenAgain = await generated.handler({});
  assert.equal(hiddenAgain.kind, "success", hiddenAgain.text);
  assert.match(hiddenAgain.text, /no longer exposed/);
  assert.ok(await waitFor(() => !tools.has("mcp_cmd_server_echo")), "the generated command did not hide the tools");

  const shownAgain = await generated.handler({});
  assert.equal(shownAgain.kind, "success", shownAgain.text);
  assert.match(shownAgain.text, /is exposed/);
  assert.ok(tools.has("mcp_cmd_server_echo"), "the generated command did not bring the tools back");

  const tested = await command.handler({ rawInput: "test cmd-server" });
  assert.equal(tested.kind, "success", tested.text);
  assert.match(tested.text, /fake-server/);

  const status = await command.handler({ rawInput: "status" });
  assert.match(status.text, /1 pool server\(s\), 1 exposed/);

  const hidden = await command.handler({ rawInput: " off cmd-server" });
  assert.equal(hidden.kind, "success", hidden.text);
  assert.ok(await waitFor(() => !tools.has("mcp_cmd_server_echo")), "the command left the tools registered");

  const missing = await command.handler({ rawInput: "on nope" });
  assert.equal(missing.kind, "error");
  assert.match(missing.text, /No pool server named "nope"/);

  const unknown = await command.handler({ rawInput: "nope" });
  assert.equal(unknown.kind, "error");
  assert.match(unknown.text, /Unknown command "nope"/);

  await tools.get("mcp_remove_server").execute({ name: "cmd-server" });
  assert.ok(await waitFor(() => !commands.has("mcp-cmd-server")), "the per-server command outlived its server");
});

test("import accepts a bare name -> server map", async () => {
  setupSandbox();
  const { ctx, routes } = createCtx();
  apply(ctx, {});

  const imported = await callRoute(routes, "POST", "action", {
    action: "import",
    text: JSON.stringify({ mcpServers: { imported: { command: "npx", args: ["-y", "pkg"] } } }),
  });
  assert.equal(imported.json.ok, true, imported.json.error);
  assert.equal(imported.json.data.added, 1);
  assert.ok(imported.json.data.snapshot.servers.some((server) => server.managed && server.name === "imported"));
});

test("mutations require the plugin header and a JSON content type", async () => {
  setupSandbox();
  const { ctx, routes } = createCtx();
  apply(ctx, {});

  const missingHeader = await callRoute(routes, "POST", "action", { action: "refresh" }, { headers: { "x-dsh-mcp-manager": "" } });
  assert.equal(missingHeader.status, 403);

  const wrongOrigin = await callRoute(routes, "POST", "action", { action: "refresh" }, { headers: { origin: "http://evil.example" } });
  assert.equal(wrongOrigin.status, 403);

  const wrongType = await callRoute(routes, "POST", "action", { action: "refresh" }, { headers: { "content-type": "text/plain" } });
  assert.equal(wrongType.status, 415);
});

test("unknown actions fail with a coded 400", async () => {
  setupSandbox();
  const { ctx, routes } = createCtx();
  apply(ctx, {});

  const response = await callRoute(routes, "POST", "action", { action: "nope" });
  assert.equal(response.status, 400);
  assert.equal(response.json.ok, false);
  assert.equal(response.json.code, "unknown-action");
});

test("discovered servers are read-only", async () => {
  setupSandbox();
  const { ctx, routes } = createCtx();
  apply(ctx, {});

  const state = await callRoute(routes, "GET", "state", undefined);
  const discoveredKey = state.json.data.snapshot.servers.find((server) => !server.managed).key;

  const removed = await callRoute(routes, "POST", "action", { action: "delete", key: discoveredKey });
  assert.equal(removed.status, 400);
  assert.equal(removed.json.code, "read-only");

  const toggled = await callRoute(routes, "POST", "action", { action: "set-enabled", key: discoveredKey, enabled: false });
  assert.equal(toggled.status, 400);
  assert.equal(toggled.json.code, "read-only");
});

test("mcp_inventory reports every server it found", async () => {
  setupSandbox();
  const { ctx, tools } = createCtx();
  apply(ctx, {});

  const inventory = await tools.get("mcp_inventory").execute({});
  assert.equal(inventory.total, 2);
  assert.match(inventory.summary, /filesystem/);
  assert.match(inventory.summary, /Cursor/);
});

test("mcp_save_server and mcp_remove_server manage the pool", async () => {
  setupSandbox();
  const { ctx, tools } = createCtx();
  apply(ctx, {});

  const saved = await tools.get("mcp_save_server").execute({ name: "from-agent", url: "https://mcp.example.com/mcp" });
  assert.match(saved.summary, /from-agent/);

  const exported = await tools.get("mcp_export_config").execute({ format: "codex" });
  assert.equal(exported.count, 1);
  assert.match(exported.text, /mcp_servers\.from-agent/);

  const removed = await tools.get("mcp_remove_server").execute({ name: "from-agent" });
  assert.equal(removed.ok, true);

  const missing = await tools.get("mcp_remove_server").execute({ name: "from-agent" });
  assert.equal(missing.ok, false);
});
