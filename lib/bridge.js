/**
 * MCP tool bridge.
 *
 * Keeps a live MCP session open for every pool server marked `expose` and
 * registers each of its tools on the harness tool registry, so the agent can
 * call them directly instead of going through a third-party connector.
 */

import { CLIENT_INFO, PROTOCOL_VERSIONS, StdioChannel, postJson } from "./probe.js";

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TOOL_NAME = 60;
const REFRESH_DEBOUNCE_MS = 600;

/** Lowercases and collapses anything that is not [a-z0-9] into `_`. */
export function slug(value) {
  const text = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return text || "server";
}

/** Builds a stable, registry-safe tool name for a server/tool pair. */
export function toolNameFor(serverName, toolName) {
  const full = `mcp_${slug(serverName)}_${slug(toolName)}`;
  return full.length <= MAX_TOOL_NAME ? full : full.slice(0, MAX_TOOL_NAME).replace(/_+$/, "");
}

function normalizeSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  const next = { ...schema };
  next.type = "object";
  if (!next.properties || typeof next.properties !== "object" || Array.isArray(next.properties)) {
    next.properties = {};
  }
  delete next.$schema;
  return next;
}

/** Flattens an MCP tools/call result into plain text for the transcript. */
export function resultText(result) {
  if (result && Array.isArray(result.content)) {
    const parts = result.content.map((part) => {
      if (part?.type === "text") return String(part.text ?? "");
      if (part?.type === "image") return `[image ${part.mimeType ?? "image"}]`;
      if (part?.type === "resource") return "[resource]";
      return `[${part?.type ?? "content"}]`;
    });
    return parts.join("\n").trim();
  }
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/* ------------------------------------------------------------- transports -- */

class StdioSession {
  constructor(spec, options = {}) {
    this.spec = spec;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onToolsChanged = options.onToolsChanged;
    this.channel = null;
    this.protocolVersion = undefined;
  }

  async start() {
    this.channel = new StdioChannel(this.spec, this.timeoutMs, (message) => {
      if (message?.method !== "notifications/tools/list_changed") return;
      try {
        this.onToolsChanged?.();
      } catch {
        /* listeners are best effort */
      }
    });
    await this.channel.start();
    await this.initialize();
  }

  async initialize() {
    let lastError;
    for (const version of PROTOCOL_VERSIONS) {
      try {
        const result = await this.channel.request("initialize", {
          protocolVersion: version,
          capabilities: { roots: { listChanged: false }, tools: { listChanged: true } },
          clientInfo: CLIENT_INFO,
        });
        this.protocolVersion = result?.protocolVersion ?? version;
        this.channel.notify("notifications/initialized", {});
        return;
      } catch (error) {
        lastError = error;
        if (!/protocol version/i.test(String(error?.message ?? ""))) break;
      }
    }
    throw lastError ?? new Error("initialize failed");
  }

  async listTools() {
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page += 1) {
      const result = await this.channel.request("tools/list", cursor ? { cursor } : {});
      for (const tool of Array.isArray(result?.tools) ? result.tools : []) {
        if (tool && typeof tool.name === "string") tools.push(tool);
      }
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  callTool(name, args) {
    return this.channel.request("tools/call", { name, arguments: args ?? {} });
  }

  stop() {
    try {
      this.channel?.stop?.();
    } catch {
      /* the child may already be gone */
    }
  }
}

class HttpSession {
  constructor(spec, options = {}) {
    this.spec = spec;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sessionId = undefined;
    this.protocolVersion = undefined;
    this.nextId = 1;
  }

  headers() {
    const headers = { ...(this.spec.headers ?? {}) };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    if (this.protocolVersion) headers["mcp-protocol-version"] = this.protocolVersion;
    return headers;
  }

  async start() {
    let lastError;
    for (const version of PROTOCOL_VERSIONS) {
      try {
        const { messages, sessionId } = await postJson(
          this.spec.url,
          this.headers(),
          {
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: { protocolVersion: version, capabilities: { tools: {} }, clientInfo: CLIENT_INFO },
          },
          this.timeoutMs,
        );
        const reply = messages.find((entry) => entry?.id === 0);
        if (reply?.error) throw new Error(reply.error.message ?? "initialize failed");
        if (!reply) throw new Error("initialize returned no reply");
        this.sessionId = sessionId;
        this.protocolVersion = reply.result?.protocolVersion ?? version;
        await this.notify("notifications/initialized");
        return;
      } catch (error) {
        lastError = error;
        if (!/protocol version/i.test(String(error?.message ?? ""))) break;
      }
    }
    throw lastError ?? new Error("initialize failed");
  }

  async notify(method, params) {
    try {
      await postJson(this.spec.url, this.headers(), { jsonrpc: "2.0", method, params }, this.timeoutMs);
    } catch {
      /* notifications are fire and forget */
    }
  }

  async request(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    const message = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    const { messages } = await postJson(this.spec.url, this.headers(), message, this.timeoutMs);
    const reply = messages.find((entry) => entry?.id === id) ?? messages.find((entry) => entry?.result || entry?.error);
    if (!reply) throw new Error(`${method} returned no reply`);
    if (reply.error) throw new Error(reply.error.message ?? `${method} failed`);
    return reply.result;
  }

  async listTools() {
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page += 1) {
      const result = await this.request("tools/list", cursor ? { cursor } : {});
      for (const tool of Array.isArray(result?.tools) ? result.tools : []) {
        if (tool && typeof tool.name === "string") tools.push(tool);
      }
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  callTool(name, args) {
    return this.request("tools/call", { name, arguments: args ?? {} });
  }

  stop() {
    /* nothing to tear down: HTTP sessions are stateless apart from the id */
  }
}

/* ---------------------------------------------------------------- bridge --- */

export class ExposureBridge {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.log = typeof options.log === "function" ? options.log : () => {};
    this.records = new Map();
    this.claimed = new Set();
    this.stopped = false;
    this.pending = Promise.resolve();
  }

  /** Runtime status for one pool server, shaped for the settings snapshot. */
  status(id) {
    const record = this.records.get(id);
    if (!record) return { state: "off", tools: [] };
    return {
      state: record.state,
      error: record.error,
      tools: record.tools.map((tool) => ({ name: tool.name, original: tool.original })),
    };
  }

  /**
   * Reconciles the live sessions with the desired set.
   * entries: [{ id, name, spec, hash }]
   */
  sync(entries) {
    this.stopped = false;
    this.pending = this.pending.then(() => this.reconcile(entries)).catch((error) => {
      this.log("bridge: sync failed", error);
    });
    return this.pending;
  }

  async reconcile(entries) {
    if (this.stopped) return;
    const desired = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || entry.enabled === false || entry.expose !== true) continue;
      desired.set(entry.id, entry);
    }
    for (const [id, record] of [...this.records]) {
      const entry = desired.get(id);
      if (!entry || entry.hash !== record.hash) await this.stop(id);
    }
    for (const [id, entry] of desired) {
      if (this.stopped) return;
      if (this.records.has(id)) {
        const record = this.records.get(id);
        if (record.state === "error" && entry.retry !== false) await this.start(entry);
        continue;
      }
      await this.start(entry);
    }
  }

  async start(entry) {
    const record = {
      id: entry.id,
      name: entry.name,
      hash: entry.hash,
      state: "connecting",
      error: undefined,
      session: null,
      tools: [],
      disposers: new Map(),
      refreshTimer: undefined,
    };
    this.records.set(entry.id, record);
    try {
      if (entry.spec.transport === "sse") {
        throw new Error("legacy SSE servers cannot be exposed yet; use a stdio or streamable HTTP endpoint");
      }
      const session =
        entry.spec.transport === "http"
          ? new HttpSession(entry.spec, { timeoutMs: entry.timeoutMs })
          : new StdioSession(entry.spec, {
              timeoutMs: entry.timeoutMs,
              onToolsChanged: () => this.scheduleRefresh(entry.id),
            });
      record.session = session;
      await session.start();
      const tools = await session.listTools();
      this.register(record, tools);
      record.state = "ready";
      this.log(`bridge: ${entry.name} exposed ${record.tools.length} tool(s)`);
    } catch (error) {
      record.state = "error";
      record.error = String(error?.message ?? error);
      this.log(`bridge: ${entry.name} unavailable: ${record.error}`);
      await this.stop(entry.id, { keep: record });
    }
  }

  register(record, tools) {
    for (const tool of tools) {
      if (!tool || typeof tool.name !== "string") continue;
      const name = toolNameFor(record.name, tool.name);
      if (this.claimed.has(name) || this.exists(name)) continue;
      const label = tool.title ?? tool.name;
      const description = String(tool.description ?? "").trim();
      const definition = {
        name,
        description: `${record.name} (MCP): ${description || label}`,
        parameters: normalizeSchema(tool.inputSchema),
        output: {
          schema: { type: "object" },
          render: (_args, value) => [{ type: "text", text: resultText(value) }],
        },
        async execute(args) {
          return record.session.callTool(tool.name, args ?? {});
        },
        presentCall(args) {
          return { card: "generic", title: `${record.name}: ${label}`, kind: "execute", rawInput: args };
        },
      };
      try {
        const dispose = this.ctx.tools.register(definition);
        record.disposers.set(name, dispose);
        record.tools.push({ name, original: tool.name });
        this.claimed.add(name);
      } catch (error) {
        this.log(`bridge: could not register ${name}`, error);
      }
    }
  }

  exists(name) {
    try {
      const getTool = this.ctx?.tools?.get;
      return typeof getTool === "function" ? Boolean(getTool.call(this.ctx.tools, name)) : false;
    } catch {
      return false;
    }
  }

  scheduleRefresh(id) {
    const record = this.records.get(id);
    if (!record || this.stopped) return;
    if (record.refreshTimer) clearTimeout(record.refreshTimer);
    record.refreshTimer = setTimeout(() => {
      record.refreshTimer = undefined;
      void this.refresh(id);
    }, REFRESH_DEBOUNCE_MS);
    record.refreshTimer.unref?.();
  }

  async refresh(id) {
    const record = this.records.get(id);
    if (!record || record.state !== "ready" || this.stopped) return;
    try {
      const tools = await record.session.listTools();
      const wanted = new Set(tools.map((tool) => slug(tool.name)));
      for (const [name, dispose] of [...record.disposers]) {
        const original = record.tools.find((item) => item.name === name)?.original;
        if (wanted.has(slug(original))) continue;
        try {
          dispose?.();
        } catch {}
        record.disposers.delete(name);
        this.claimed.delete(name);
      }
      record.tools = record.tools.filter((item) => record.disposers.has(item.name));
      this.register(record, tools);
      this.log(`bridge: ${record.name} refreshed (${record.tools.length} tool(s))`);
    } catch (error) {
      this.log(`bridge: refresh of ${record.name} failed`, error);
    }
  }

  async stop(id, options = {}) {
    const record = this.records.get(id);
    if (!record) return;
    if (record.refreshTimer) clearTimeout(record.refreshTimer);
    this.records.delete(id);
    for (const [name, dispose] of record.disposers) {
      try {
        dispose?.();
      } catch {}
      this.claimed.delete(name);
    }
    record.disposers.clear();
    record.tools = [];
    try {
      record.session?.stop?.();
    } catch {}
    if (options.keep) {
      record.state = "error";
      record.session = null;
      this.records.set(id, record);
    }
  }

  async stopAll() {
    this.stopped = true;
    for (const id of [...this.records.keys()]) await this.stop(id);
    await this.pending.catch(() => {});
  }
}
