import assert from "node:assert/strict";
import test from "node:test";

/* Renders the settings page with a tiny React substitute: function components are
 * invoked eagerly, hooks keep their slots between render passes, and effects flush
 * after each pass. It does not model the DOM, but it does exercise the whole tree
 * with realistic snapshot data (something the loading-state smoke test cannot). */

let slots = [];
let slotIndex = 0;
let refs = [];
let refIndex = 0;
let callbacks = [];
let cbIndex = 0;
let effects = [];
let effectIndex = 0;
let pending = [];
let needsRender = false;

function sameDeps(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => Object.is(value, b[index]));
}

function flatten(children, out) {
  for (const child of children) {
    if (child === null || child === undefined || typeof child === "boolean") continue;
    if (Array.isArray(child)) flatten(child, out);
    else out.push(child);
  }
  return out;
}

function createElement(type, props, ...children) {
  const next = { ...(props ?? {}) };
  const flat = flatten(children, []);
  if (flat.length) next.children = flat.length === 1 ? flat[0] : flat;
  if (typeof type === "function") return type(next);
  return { type, props: next };
}

const ReactStub = {
  Fragment: Symbol("Fragment"),
  createElement,
  useState(initial) {
    const index = slotIndex++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    const set = (value) => {
      const resolved = typeof value === "function" ? value(slots[index]) : value;
      if (Object.is(resolved, slots[index])) return;
      slots[index] = resolved;
      needsRender = true;
    };
    return [slots[index], set];
  },
  useRef(initial) {
    const index = refIndex++;
    if (!(index in refs)) refs[index] = { current: initial };
    return refs[index];
  },
  useCallback(fn, deps) {
    const index = cbIndex++;
    const previous = callbacks[index];
    if (previous && sameDeps(previous.deps, deps)) return previous.fn;
    callbacks[index] = { fn, deps };
    return fn;
  },
  useEffect(fn, deps) {
    const index = effectIndex++;
    const previous = effects[index];
    if (!previous || !sameDeps(previous.deps, deps)) pending.push(fn);
    effects[index] = { fn, deps };
  },
};

/* ------------------------------------------------------------------ globals --- */

const requests = [];
const snapshot = {
  servers: [
    {
      key: "managed:abc123",
      id: "abc123",
      managed: true,
      name: "local-files",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
      env: { ROOT: "C:\\work" },
      headers: {},
      cwd: "",
      url: "",
      enabled: true,
      note: "",
      tags: [],
      scope: "managed",
      sourceId: "pool",
      sourceLabel: "Server pool",
      sourceApp: "MCP Manager",
      display: "npx -y @modelcontextprotocol/server-filesystem",
      sourcePath: "Managed here",
      envKeys: ["ROOT"],
      headerKeys: [],
      updatedAt: new Date().toISOString(),
      probe: {
        ok: true,
        at: new Date().toISOString(),
        ms: 42,
        toolCount: 3,
        serverName: "fake-server",
        serverVersion: "0.1.0",
        protocolVersion: "2025-06-18",
        instructions: "Test instructions.",
        tools: [{ name: "read_file", description: "Read a file." }, { name: "write_file" }, { name: "list" }],
      },
    },
    {
      key: "cursor#remote",
      managed: false,
      name: "remote",
      transport: "http",
      url: "https://mcp.example.com/mcp?api_key=***",
      command: "",
      args: [],
      env: {},
      headers: { authorization: "••••••1234" },
      enabled: true,
      note: "",
      tags: [],
      scope: "user",
      sourceId: "cursor",
      sourceLabel: "mcp.json",
      sourceApp: "Cursor",
      display: "https://mcp.example.com/mcp",
      sourcePath: "~\\.cursor\\mcp.json",
      envKeys: [],
      headerKeys: ["authorization"],
      updatedAt: new Date().toISOString(),
      probe: null,
    },
  ],
  sources: [
    {
      id: "cursor",
      label: "Cursor",
      app: "Cursor",
      format: "standard",
      file: "C:\\Users\\demo\\.cursor\\mcp.json",
      path: "~\\.cursor\\mcp.json",
      exists: true,
      count: 1,
      size: 512,
      updatedAt: new Date().toISOString(),
      error: null,
    },
    {
      id: "claude",
      label: "Claude Desktop",
      app: "Claude",
      format: "standard",
      file: "C:\\Users\\demo\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
      path: "~/AppData/Roaming/Claude/claude_desktop_config.json",
      exists: false,
      count: 0,
      size: 0,
      updatedAt: null,
      error: null,
    },
  ],
  trash: [
    {
      id: "t1",
      name: "old-server",
      transport: "stdio",
      display: "npx old-server",
      enabled: false,
      note: "",
      args: [],
      env: {},
      headers: {},
      deletedAt: new Date().toISOString(),
    },
  ],
  stats: { total: 2, healthy: 1, failing: 0, untested: 1 },
  workspaces: [{ id: "w1", title: "Proyectos", path: "C:\\work", fullPath: "C:\\work" }],
  statePath: "C:\\Users\\demo\\.dsh\\mcp-manager\\state.json",
  scannedAt: new Date().toISOString(),
  corruptState: null,
};

globalThis.window = {
  location: { origin: "http://127.0.0.1:57256" },
  addEventListener() {},
  removeEventListener() {},
  confirm: () => true,
  __ModuleLoader__: { load(definition) { globalThis.__mcpManagerModule = definition; } },
};
globalThis.document = { baseURI: "http://127.0.0.1:57256/", body: { appendChild() {}, removeChild() {} } };
globalThis.fetch = async (url, options = {}) => {
  requests.push({ url: String(url), options });
  const payload = String(options.body ?? "").includes('"action"')
    ? { ok: true, data: { results: [{ ok: true, toolCount: 2 }], snapshot } }
    : { ok: true, data: { snapshot } };
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
};

/* ------------------------------------------------------------------ helpers --- */

function fakeRequire(name) {
  if (name === "react") return ReactStub;
  throw new Error(`unexpected require("${name}")`);
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (node.type === "style") return "";
  return textOf(node.props?.children);
}

function collect(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) collect(item, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  collect(node.props?.children, predicate, out);
  return out;
}

function click(tree, label) {
  const matches = collect(tree, (node) => {
    if (!node || typeof node.props?.onClick !== "function") return false;
    const value = textOf(node).trim();
    return value === label || value.startsWith(`${label} `);
  });
  assert.ok(matches.length, `no clickable element labelled "${label}"`);
  matches[0].props.onClick({ stopPropagation() {}, preventDefault() {} });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/* Loads the bundle once and returns every slot registration the client makes,
 * keyed by slot name, so a test can render the settings section or the panel. */
function loadClient() {
  const exported = globalThis.__mcpManagerModule.factory(fakeRequire);
  const registrations = new Map();
  exported.apply({
    effect: (callback) => callback(),
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (key, callback) => {
        registrations.set(key, callback());
      },
      register: (options, component) => {
        const entry = { options, component };
        registrations.set(options.name, entry);
        return entry;
      },
    },
  });
  return registrations;
}

function render(section) {
  slotIndex = 0;
  refIndex = 0;
  cbIndex = 0;
  effectIndex = 0;
  pending = [];
  needsRender = false;
  const tree = section({ close() {} });
  const ready = pending;
  pending = [];
  for (const effect of ready) effect();
  return tree;
}

async function settle(section) {
  let tree = render(section);
  for (let round = 0; round < 8; round += 1) {
    await tick();
    if (!needsRender) break;
    tree = render(section);
  }
  return tree;
}

/* -------------------------------------------------------------------- tests --- */

test("the settings page renders discovered and pooled servers", async () => {
  await import("../lib/client.js");
  const registrations = loadClient();
  const section = registrations.get("settings.section").component;

  const tree = await settle(section);
  const text = textOf(tree);

  assert.match(text, /MCP Manager/);
  assert.match(text, /local-files/);
  assert.match(text, /remote/);
  assert.match(text, /3 tools/);
  assert.match(text, /Not tested/);
  assert.match(text, /New server/);
  assert.match(text, /pool state C:\\Users\\demo\\\.dsh\\mcp-manager\\state\.json/);
  assert.equal(requests[0].url, "http://127.0.0.1:57256/api/dsh-mcp-manager/state");
});

test("tabs, expansion and search drive the page", async () => {
  const section = loadClient().get("settings.section").component;
  let tree = await settle(section);

  click(tree, "Sources");
  tree = await settle(section);
  assert.match(textOf(tree), /\.cursor[\\/]mcp\.json/);
  assert.match(textOf(tree), /not found/);

  click(tree, "Trash");
  tree = await settle(section);
  assert.match(textOf(tree), /old-server/);

  click(tree, "Servers");
  tree = await settle(section);

  const rowHead = collect(tree, (node) => node?.props?.className === "mcpm-row-head")[0];
  assert.ok(rowHead);
  rowHead.props.onClick();
  tree = await settle(section);
  const expanded = textOf(tree);
  assert.match(expanded, /read_file/);
  assert.match(expanded, /2025-06-18/);
  assert.match(expanded, /ROOT/);

  const search = collect(tree, (node) => node?.props?.className === "mcpm-input mcpm-search")[0];
  search.props.onChange({ target: { value: "nothing-matches" } });
  tree = await settle(section);
  assert.match(textOf(tree), /No server matches this filter/);
});

test("the editor validates input before saving", async () => {
  const section = loadClient().get("settings.section").component;
  let tree = await settle(section);

  click(tree, "New server");
  tree = await settle(section);
  assert.match(textOf(tree), /New MCP server/);
  assert.match(textOf(tree), /Transport/);

  click(tree, "Save");
  tree = await settle(section);
  assert.match(textOf(tree), /A name is required\./);
});

test("the sidebar icon and the main panel render the same page", async () => {
  const registrations = loadClient();

  const sidebar = registrations.get("sidebar.panellist");
  assert.ok(sidebar, "the sidebar entry was not registered");
  assert.equal(sidebar.options.id, "mcp-manager");

  const icon = sidebar.component({ size: 22, active: true });
  assert.equal(icon.type, "svg");
  assert.equal(icon.props.width, 22);
  assert.equal(icon.props.height, 22);
  assert.match(icon.props.dangerouslySetInnerHTML.__html, /<rect/);
  assert.equal(sidebar.component({}).props.width, 16, "the icon should fall back to 16px");

  const panel = registrations.get("main");
  assert.ok(panel, "the main panel was not registered");
  assert.equal(panel.options.key, "mcp-manager");

  const tree = await settle(panel.component);
  assert.equal(tree.type, "div");
  assert.equal(tree.props.className, "mcpm-page");
  assert.match(textOf(tree), /New server/);
});
