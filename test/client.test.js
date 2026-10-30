import assert from "node:assert/strict";
import test from "node:test";

/* Loads the browser module in Node with a stub module loader and a stub React,
 * then checks the registration contract the host UI expects. It cannot verify
 * visuals, only that the bundle evaluates and wires its slots correctly. */

const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol("Fragment"),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
};

let loaded;
globalThis.window = {
  location: { origin: "http://127.0.0.1:57256" },
  __ModuleLoader__: {
    load(definition) {
      loaded = definition;
    },
  },
};

function fakeRequire(name) {
  if (name === "react") return ReactStub;
  throw new Error(`unexpected require("${name}")`);
}

/* Runs apply() and returns every registration by slot name. */
function mount() {
  const exported = loaded.factory(fakeRequire);
  const registrations = new Map();
  const localized = { value: undefined };
  exported.apply({
    effect: (callback) => {
      const dispose = callback();
      return typeof dispose === "function" ? dispose : () => {};
    },
    locale: {
      register: (namespace, dictionaries) => {
        localized.value = { namespace, dictionaries };
        return () => {};
      },
      bind: (namespace) => (key) => (namespace === "mcp-manager" && key === "title" ? "MCP Manager" : key),
    },
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
  return { exported, registrations, localized: localized.value };
}

test("the client bundle registers a settings section, a sidebar entry and a panel", async () => {
  await import("../lib/client.js");

  assert.equal(loaded.id, "@zarpyk/dsh-mcp-manager");
  assert.equal(typeof loaded.factory, "function");

  const exported = loaded.factory(fakeRequire);
  assert.deepEqual(exported.inject, ["slots"]);
  assert.equal(typeof exported.apply, "function");

  const { registrations, localized } = mount();

  const section = registrations.get("settings.section");
  assert.ok(section, "the settings section was not registered");
  assert.equal(section.options.name, "settings.section");
  assert.equal(section.options.id, "mcp-manager");
  assert.equal(section.options.order, 26);
  assert.equal(section.options.locale, "mcp-manager");
  assert.equal(section.options.label(), "MCP Manager");
  assert.equal(typeof section.component, "function");

  const sidebar = registrations.get("sidebar.panellist");
  assert.ok(sidebar, "the sidebar entry was not registered");
  assert.equal(sidebar.options.name, "sidebar.panellist");
  assert.equal(sidebar.options.id, "mcp-manager");
  assert.equal(sidebar.options.order, 3);
  assert.equal(sidebar.options.label(), "MCP Manager");
  const icon = sidebar.component({ size: 20, active: false });
  assert.equal(icon.type, "svg");
  assert.equal(icon.props.width, 20);
  assert.equal(icon.props.height, 20);

  const panel = registrations.get("main");
  assert.ok(panel, "the main panel was not registered");
  assert.equal(panel.options.name, "main");
  assert.equal(panel.options.key, "mcp-manager");
  assert.equal(panel.component({}).props.className, "mcpm-page");

  assert.equal(localized.namespace, "mcp-manager");
  assert.equal(localized.dictionaries.en.title, "MCP Manager");
});

test("the section component renders its loading state without throwing", () => {
  const { registrations } = mount();
  const tree = registrations.get("settings.section").component({});
  assert.ok(tree);
  assert.equal(tree.type, "div");
  assert.equal(tree.props.className, "mcpm");
  assert.match(JSON.stringify(tree.children), /Loading MCP servers/);
});

test("apply survives a client runtime without locale or slots", () => {
  const exported = loaded.factory(fakeRequire);
  assert.doesNotThrow(() => exported.apply({}));
  assert.doesNotThrow(() => exported.apply({ effect: () => () => {}, locale: { register() { throw new Error("nope"); } } }));
});
