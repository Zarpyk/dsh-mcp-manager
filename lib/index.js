import path from "node:path";
import { scanAll } from "./discovery.js";
import { describeSpec, isPlainObject, redactUrl, specHash } from "./parse.js";
import { probeServer } from "./probe.js";
import { dshHomeDir, shortPath } from "./sources.js";
import { loadState, newId, saveState } from "./state.js";

export const name = "mcp-manager";
export const inject = ["connection", "tools"];

const API_PREFIX = "/api/dsh-mcp-manager";
const MUTATION_HEADER = "x-dsh-mcp-manager";
const MAX_BODY = 512 * 1024;
const PROBE_TIMEOUT_MS = 30000;

/* --------------------------------------------------------------- errors --- */

class CodedError extends Error {
  constructor(message, statusCode = 400, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

/* ----------------------------------------------------------- serializers --- */

function stateFile() {
  return path.join(dshHomeDir(), "mcp-manager", "state.json");
}

function compactProbe(probe) {
  if (!probe) return null;
  return {
    ok: probe.ok === true,
    at: probe.at,
    ms: probe.ms,
    error: probe.error,
    hint: probe.hint,
    toolCount: probe.toolCount,
    serverName: probe.serverName,
    serverVersion: probe.serverVersion,
    protocolVersion: probe.protocolVersion,
    instructions: probe.instructions,
    tools: Array.isArray(probe.tools) ? probe.tools.slice(0, 100) : undefined,
  };
}

function publicServer(server, probes) {
  const cached = probes[server.key];
  const fresh = cached && cached.specHash === server.specHash ? cached : undefined;
  return {
    key: server.key,
    name: server.name,
    managed: server.managed === true,
    scope: server.scope,
    transport: server.transport,
    type: server.type,
    sourceId: server.sourceId,
    sourceLabel: server.sourceLabel,
    sourceApp: server.sourceApp,
    sourcePath: server.sourcePath,
    workspace: server.workspace,
    command: server.command,
    args: server.args,
    cwd: server.cwd,
    url: server.url,
    envKeys: server.envKeys,
    headerKeys: server.headerKeys,
    enabled: server.enabled,
    display: server.display,
    specHash: server.specHash,
    note: server.note,
    tags: server.tags,
    probe: compactProbe(fresh?.probe),
  };
}

function managedServer(entry) {
  const spec = {
    transport: entry.transport,
    type: entry.transport,
    command: entry.command,
    args: entry.args,
    cwd: entry.cwd,
    url: entry.url,
    env: entry.env,
    headers: entry.headers,
    enabled: entry.enabled,
  };
  return {
    key: `managed:${entry.id}`,
    name: entry.name,
    managed: true,
    scope: "managed",
    transport: entry.transport,
    type: entry.transport,
    sourceId: "managed",
    sourceLabel: "Server pool",
    sourceApp: "MCP Manager",
    sourcePath: "Managed here",
    workspace: null,
    command: entry.command,
    args: entry.args,
    cwd: entry.cwd,
    url: redactUrl(entry.url),
    envKeys: Object.keys(entry.env),
    headerKeys: Object.keys(entry.headers),
    enabled: entry.enabled,
    display: describeSpec(spec),
    specHash: specHash(spec),
    note: entry.note,
    tags: entry.tags,
    spec,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

/* ------------------------------------------------------------- workspace --- */

function workspaceList(ctx) {
  try {
    const registry = typeof ctx.get === "function" ? ctx.get("workspaceRegistry") : undefined;
    if (!registry || typeof registry.list !== "function") return [];
    return registry
      .list()
      .map((item) => ({ id: String(item?.id ?? ""), title: String(item?.title ?? item?.name ?? item?.path ?? ""), path: String(item?.path ?? item?.cwd ?? "") }))
      .filter((item) => item.path);
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------- snapshot --- */

async function buildSnapshot(ctx, options = {}) {
  const file = stateFile();
  const state = await loadState(file);
  const workspaces = workspaceList(ctx);
  const selected = options.workspace && workspaces.some((item) => item.path === options.workspace) ? [options.workspace] : workspaces.map((item) => item.path).slice(0, 12);

  const scan = await scanAll({ workspaces: selected });
  const probes = isPlainObject(state.probes) ? state.probes : {};

  const servers = [];
  for (const entry of Object.values(state.servers)) servers.push(publicServer(managedServer(entry), probes));
  for (const server of scan.servers) servers.push(publicServer(server, probes));

  servers.sort((a, b) => {
    if (a.managed !== b.managed) return a.managed ? -1 : 1;
    if (a.sourceLabel !== b.sourceLabel) return a.sourceLabel.localeCompare(b.sourceLabel);
    return a.name.localeCompare(b.name);
  });

  const trash = Object.values(state.trash)
    .map((entry) => ({ id: entry.id, name: entry.name, transport: entry.transport, deletedAt: entry.deletedAt, display: describeSpec(entry) }))
    .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));

  const stats = {
    total: servers.length,
    managed: servers.filter((item) => item.managed).length,
    healthy: servers.filter((item) => item.probe?.ok).length,
    failing: servers.filter((item) => item.probe && !item.probe.ok).length,
    untested: servers.filter((item) => !item.probe).length,
    disabled: servers.filter((item) => !item.enabled).length,
    remote: servers.filter((item) => item.transport !== "stdio").length,
  };

  return {
    servers,
    sources: scan.sources,
    trash,
    stats,
    workspaces: workspaces.map((item) => ({ id: item.id, title: item.title, path: shortPath(item.path), fullPath: item.path })),
    scannedAt: scan.scannedAt,
    statePath: shortPath(file),
    stateFile: file,
    corruptState: state.corrupt ?? null,
  };
}

/* --------------------------------------------------------- probe helper --- */

async function mapLimit(items, limit, worker) {
  const results = [];
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(runners);
  return results;
}

async function probeEntries(ctx, keys, state) {
  const workspaces = workspaceList(ctx).map((item) => item.path).slice(0, 12);
  const scan = await scanAll({ workspaces });
  const discovered = new Map(scan.servers.map((server) => [server.key, server]));
  const managed = new Map(Object.values(state.servers).map((entry) => [`managed:${entry.id}`, managedServer(entry)]));

  const targets = keys.filter((key) => managed.has(key) || discovered.has(key));
  if (!targets.length) throw new CodedError("no probeable server matched the request", 400, "no-target");

  const results = await mapLimit(targets, 3, async (key) => {
    const server = managed.get(key) ?? discovered.get(key);
    const spec = server.managed ? server.spec : server.spec;
    const probe = await probeServer(spec, { timeoutMs: PROBE_TIMEOUT_MS });
    return { key, specHash: server.specHash, probe };
  });

  for (const result of results) {
    if (result.specHash) state.probes[result.key] = { specHash: result.specHash, at: result.probe.at, probe: compactProbe(result.probe) };
  }
  await saveState(stateFile(), state);
  return results.map((result) => ({ key: result.key, ok: result.probe.ok, error: result.probe.error, toolCount: result.probe.toolCount }));
}

/* -------------------------------------------------------------- actions --- */

function stringField(value, field, { max = 200, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new CodedError(`${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new CodedError(`${field} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new CodedError(`${field} is required`);
  if (trimmed.length > max) throw new CodedError(`${field} is longer than ${max} characters`);
  if (/[\r\n]/.test(trimmed)) throw new CodedError(`${field} must be a single line`);
  return trimmed;
}

function stringArrayField(value, field) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new CodedError(`${field} must be an array of strings`);
  return value.map((item) => item.trim()).filter(Boolean);
}

function mapField(value, field) {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) throw new CodedError(`${field} must be an object of string values`);
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new CodedError(`${field}.${key} must be a string`);
    if (key.trim()) out[key.trim()] = entry;
  }
  return out;
}

function validateSpec(body) {
  const transport = body.transport === undefined ? undefined : String(body.transport);
  if (transport !== undefined && !["stdio", "http", "sse"].includes(transport)) throw new CodedError("transport must be stdio, http or sse");
  const command = stringField(body.command, "command", { max: 500 });
  const url = stringField(body.url, "url", { max: 2000 });
  const args = stringArrayField(body.args, "args");
  const env = mapField(body.env, "env");
  const headers = mapField(body.headers, "headers");
  const cwd = stringField(body.cwd, "cwd", { max: 1000 });
  const resolvedTransport = transport ?? (url && !command ? "http" : "stdio");
  if (resolvedTransport === "stdio" && !command) throw new CodedError("a stdio server needs a command");
  if (resolvedTransport !== "stdio") {
    if (!url) throw new CodedError(`a ${resolvedTransport} server needs a url`);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new CodedError("url is not a valid URL");
    }
    if (!/^https?:$/.test(parsed.protocol)) throw new CodedError("url must use http:// or https://");
  }
  return { transport: resolvedTransport, command: command ?? "", args: args ?? [], env: env ?? {}, cwd: cwd ?? "", url: url ?? "", headers: headers ?? {} };
}

function upsertFromBody(state, body) {
  const spec = validateSpec(body);
  const id = typeof body.id === "string" && state.servers[body.id] ? body.id : newId();
  const existing = state.servers[id];
  const name = stringField(body.name, "name", { max: 80, required: true });
  const duplicate = Object.values(state.servers).find((entry) => entry.id !== id && entry.name.toLowerCase() === name.toLowerCase());
  if (duplicate) throw new CodedError(`a server named "${name}" already exists in the pool`, 409, "duplicate-name");
  const now = new Date().toISOString();
  state.servers[id] = {
    id,
    name,
    ...spec,
    enabled: body.enabled === undefined ? existing?.enabled ?? true : body.enabled !== false,
    note: body.note === undefined ? existing?.note ?? "" : stringField(body.note, "note", { max: 400 }) ?? "",
    tags: body.tags === undefined ? existing?.tags ?? [] : stringArrayField(body.tags, "tags") ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    probe: null,
  };
  delete state.probes[`managed:${id}`];
  return state.servers[id];
}

/* --------------------------------------------------------------- routes --- */

function jsonResponse(status, payload, headOnly = false) {
  const body = JSON.stringify(payload);
  return new Response(headOnly ? null : body, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function runTask(task) {
  try {
    return jsonResponse(200, { ok: true, data: await task() });
  } catch (error) {
    const status = error instanceof CodedError ? error.statusCode : error?.statusCode ?? 500;
    return jsonResponse(status, { ok: false, error: error instanceof Error ? error.message : String(error), code: error?.code });
  }
}

function validateMutation(request) {
  const header = request.headers.get(MUTATION_HEADER);
  if (header !== "1") throw Object.assign(new Error("forbidden mutation request"), { statusCode: 403 });
  const origin = request.headers.get("origin");
  if (origin) {
    let host;
    try {
      host = new URL(request.url).host;
    } catch {
      host = "";
    }
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = "invalid";
    }
    if (originHost && host && originHost !== host) throw Object.assign(new Error("forbidden cross-origin mutation request"), { statusCode: 403 });
  }
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("application/json")) throw Object.assign(new Error("content-type must be application/json"), { statusCode: 415 });
}

function requireState(state) {
  if (state.corrupt) {
    throw new CodedError(`the state file is unreadable (${state.corrupt}); fix or delete ${stateFile()}`, 500, "corrupt-state");
  }
  return state;
}

async function handleAction(ctx, request) {
  return runTask(async () => {
    validateMutation(request);
    const raw = await request.text();
    if (raw.length > MAX_BODY) throw new CodedError("request body is too large", 413, "body-too-large");
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      throw new CodedError("request body is not valid JSON", 400, "invalid-json");
    }
    if (!isPlainObject(body) || typeof body.action !== "string") throw new CodedError("action is required", 400, "invalid-body");

    const file = stateFile();
    const state = requireState(await loadState(file));

    switch (body.action) {
      case "refresh":
        return { snapshot: await buildSnapshot(ctx) };

      case "probe": {
        const keys = stringArrayField(body.keys, "keys") ?? [];
        if (!keys.length) throw new CodedError("keys is required");
        const results = await probeEntries(ctx, keys, state);
        return { results, snapshot: await buildSnapshot(ctx) };
      }

      case "get": {
        const id = managedId(body.id ?? body.key);
        const entry = state.servers[id];
        if (!entry) throw new CodedError("server not found in the pool", 404, "not-found");
        return { entry };
      }

      case "save": {
        const key = body.id ?? body.key;
        const entry = upsertFromBody(state, { ...body, id: key ? managedId(key) : undefined });
        await saveState(file, state);
        return { entry, snapshot: await buildSnapshot(ctx) };
      }

      case "spec": {
        const key = String(body.key ?? body.id ?? "");
        if (key.startsWith("managed:")) {
          const entry = state.servers[managedId(key)];
          if (!entry) throw new CodedError("server not found in the pool", 404, "not-found");
          return { server: { ...entry, key, managed: true } };
        }
        const workspaces = workspaceList(ctx).map((item) => item.path).slice(0, 12);
        const scan = await scanAll({ workspaces });
        const found = scan.servers.find((server) => server.key === key);
        if (!found) throw new CodedError("server not found in the scanned configs", 404, "not-found");
        return {
          server: {
            ...found.spec,
            key: found.key,
            name: found.name,
            managed: false,
            sourceId: found.sourceId,
            sourceLabel: found.sourceLabel,
            sourceApp: found.sourceApp,
            sourcePath: found.sourcePath,
          },
        };
      }

      case "set-enabled": {
        const id = managedId(body.id ?? body.key);
        const entry = state.servers[id];
        if (!entry) throw new CodedError("only servers in the pool can be toggled here; discovered entries are read-only", 400, "read-only");
        entry.enabled = body.enabled !== false;
        entry.updatedAt = new Date().toISOString();
        await saveState(file, state);
        return { snapshot: await buildSnapshot(ctx) };
      }

      case "delete": {
        const id = managedId(body.id ?? body.key);
        const entry = state.servers[id];
        if (!entry) throw new CodedError("only servers in the pool can be deleted here; discovered entries are read-only", 400, "read-only");
        delete state.servers[id];
        delete state.probes[`managed:${id}`];
        state.trash[id] = { ...entry, deletedAt: new Date().toISOString() };
        await saveState(file, state);
        return { snapshot: await buildSnapshot(ctx) };
      }

      case "restore": {
        const id = String(body.id ?? "");
        const entry = state.trash[id];
        if (!entry) throw new CodedError("trash entry not found", 404, "not-found");
        delete state.trash[id];
        const { deletedAt, ...restorable } = entry;
        state.servers[id] = restorable;
        await saveState(file, state);
        return { snapshot: await buildSnapshot(ctx) };
      }

      case "purge": {
        const id = String(body.id ?? "");
        if (!state.trash[id]) throw new CodedError("trash entry not found", 404, "not-found");
        delete state.trash[id];
        await saveState(file, state);
        return { snapshot: await buildSnapshot(ctx) };
      }

      case "empty-trash": {
        state.trash = {};
        await saveState(file, state);
        return { snapshot: await buildSnapshot(ctx) };
      }

      case "import": {
        const text = typeof body.text === "string" ? body.text : "";
        if (!text.trim()) throw new CodedError("text is required");
        const parsed = parseImport(text);
        let added = 0;
        for (const item of parsed) {
          try {
            upsertFromBody(state, item);
            added += 1;
          } catch (error) {
            if (!(error instanceof CodedError && error.statusCode === 409)) throw error;
          }
        }
        await saveState(file, state);
        return { added, total: parsed.length, snapshot: await buildSnapshot(ctx) };
      }

      case "export": {
        const format = ["json", "vscode", "codex"].includes(body.format) ? body.format : "json";
        const keys = stringArrayField(body.keys, "keys") ?? Object.keys(state.servers).map((id) => `managed:${id}`);
        const entries = keys
          .map((key) => {
            const id = managedId(key);
            return state.servers[id];
          })
          .filter(Boolean);
        return { format, text: exportConfig(format, entries) };
      }

      default:
        throw new CodedError(`unknown action: ${body.action}`, 400, "unknown-action");
    }
  });
}

function managedId(value) {
  return String(value ?? "").replace(/^managed:/, "");
}

function parseImport(text) {
  const trimmed = text.trim();
  let document;
  if (trimmed.startsWith("{")) {
    try {
      document = JSON.parse(trimmed);
    } catch (error) {
      throw new CodedError(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    throw new CodedError("paste a JSON document (an MCP config or a bare name -> server map)");
  }
  const container = isPlainObject(document?.mcpServers)
    ? document.mcpServers
    : isPlainObject(document?.servers)
      ? document.servers
      : isPlainObject(document)
        ? document
        : undefined;
  if (!container) throw new CodedError("no server entries found in that document");
  const items = [];
  for (const [key, raw] of Object.entries(container)) {
    if (!isPlainObject(raw)) continue;
    const command = typeof raw.command === "string" ? raw.command : "";
    const url = typeof raw.url === "string" ? raw.url : typeof raw.serverUrl === "string" ? raw.serverUrl : "";
    if (!command && !url) continue;
    items.push({
      name: typeof raw.name === "string" ? raw.name : key,
      transport: raw.type === "sse" ? "sse" : raw.type === "http" || url ? "http" : "stdio",
      command,
      args: Array.isArray(raw.args) ? raw.args.filter((item) => typeof item === "string") : [],
      env: isPlainObject(raw.env) ? raw.env : {},
      headers: isPlainObject(raw.headers) ? raw.headers : isPlainObject(raw.http_headers) ? raw.http_headers : {},
      url,
      enabled: raw.disabled !== true && raw.enabled !== false,
    });
  }
  if (!items.length) throw new CodedError("no usable server entries found in that document");
  return items;
}

function tomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function exportConfig(format, entries) {
  if (format === "codex") {
    const blocks = entries.map((entry) => {
      const lines = [`[mcp_servers.${entry.name.replace(/[^A-Za-z0-9_-]/g, "_")}]`];
      if (entry.transport === "stdio") {
        lines.push(`command = ${tomlString(entry.command)}`);
        if (entry.args.length) lines.push(`args = [${entry.args.map(tomlString).join(", ")}]`);
      } else {
        lines.push(`url = ${tomlString(entry.url)}`);
        const header = Object.entries(entry.headers ?? {});
        if (header.length) lines.push(`http_headers = { ${header.map(([key, value]) => `${key} = ${tomlString(value)}`).join(", ")} }`);
      }
      const env = Object.entries(entry.env ?? {});
      if (entry.transport === "stdio" && env.length) {
        lines.push("", `[mcp_servers.${entry.name.replace(/[^A-Za-z0-9_-]/g, "_")}.env]`);
        for (const [key, value] of env) lines.push(`${key} = ${tomlString(value)}`);
      }
      return lines.join("\n");
    });
    return `${blocks.join("\n\n")}\n`;
  }

  const map = {};
  for (const entry of entries) {
    if (entry.transport === "stdio") {
      map[entry.name] = { command: entry.command, args: entry.args, ...(Object.keys(entry.env ?? {}).length ? { env: entry.env } : {}) };
    } else {
      map[entry.name] = {
        type: entry.transport,
        url: entry.url,
        ...(Object.keys(entry.headers ?? {}).length ? { headers: entry.headers } : {}),
      };
    }
  }
  const body = { [format === "vscode" ? "servers" : "mcpServers"]: map };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/* ----------------------------------------------------------------- tools --- */

function inventoryText(servers) {
  if (!servers.length) return "No MCP servers found.";
  return servers
    .map((server) => {
      const status = server.probe ? (server.probe.ok ? `ok, ${server.probe.toolCount ?? 0} tools` : `failed: ${server.probe.error}`) : "untested";
      return `- ${server.name} [${server.transport}] ${server.enabled ? "enabled" : "disabled"} — ${server.sourceLabel} (${server.scope}) — ${status}`;
    })
    .join("\n");
}

function registerTools(ctx) {
  const tools = ctx.tools;
  if (!tools || typeof tools.register !== "function") return;

  ctx.effect(
    () =>
      tools.register({
        name: "mcp_inventory",
        description:
          "List MCP server definitions found on this machine (DeepSeek Harness, Claude, Cursor, VS Code, Codex, Zed, Gemini, OpenCode, Cline and similar clients) plus servers saved in the MCP Manager pool. Use before editing a config so you know what already exists.",
        parameters: {
          type: "object",
          properties: {
            scope: { type: "string", enum: ["all", "user", "project", "managed"], description: "Restrict to one scope. Default all." },
          },
          additionalProperties: false,
        },
        output: {
          schema: { type: "object", properties: { summary: { type: "string" }, total: { type: "number" } }, required: ["summary", "total"] },
          render: (_args, value) => [{ type: "text", text: String(value?.summary ?? "") }],
        },
        async execute(args) {
          const snapshot = await buildSnapshot(ctx);
          const scope = args?.scope ?? "all";
          const servers = scope === "all" ? snapshot.servers : snapshot.servers.filter((server) => server.scope === scope);
          return { total: servers.length, summary: `${servers.length} MCP server(s):\n${inventoryText(servers)}` };
        },
      }),
    "mcp-manager: mcp_inventory tool",
  );

  ctx.effect(
    () =>
      tools.register({
        name: "mcp_probe",
        description:
          "Connect to one MCP server, run the MCP initialize handshake and list its tools. Works for stdio servers (spawned on demand) and HTTP/SSE servers. Returns server metadata, protocol version and tool names, or the connection error.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Exact server name from mcp_inventory." },
            source: { type: "string", description: "Optional source label or id to disambiguate servers with the same name." },
          },
          required: ["name"],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: "object",
            properties: { ok: { type: "boolean" }, summary: { type: "string" } },
            required: ["ok", "summary"],
          },
          render: (_args, value) => [{ type: "text", text: String(value?.summary ?? "") }],
        },
        async execute(args) {
          const snapshot = await buildSnapshot(ctx);
          const name = String(args?.name ?? "").toLowerCase();
          const candidates = snapshot.servers.filter((server) => server.name.toLowerCase() === name);
          const filtered = args?.source ? candidates.filter((server) => `${server.sourceLabel} ${server.sourceId}`.toLowerCase().includes(String(args.source).toLowerCase())) : candidates;
          if (!filtered.length) return { ok: false, summary: `No MCP server named "${args?.name}".` };
          const target = filtered.find((server) => server.managed) ?? filtered[0];
          const state = await loadState(stateFile());
          const results = await probeEntries(ctx, [target.key], state);
          const result = results[0];
          if (!result?.ok) return { ok: false, summary: `Probe failed for ${target.name}: ${result?.error ?? "unknown error"}` };
          const refreshed = await buildSnapshot(ctx);
          const server = refreshed.servers.find((item) => item.key === target.key);
          const toolLines = (server?.probe?.tools ?? []).map((tool) => `- ${tool.name}${tool.description ? `: ${tool.description.split("\n")[0]}` : ""}`).join("\n");
          return {
            ok: true,
            summary: `${target.name} is reachable (${server?.probe?.serverName ?? "unknown"} ${server?.probe?.serverVersion ?? ""}, protocol ${server?.probe?.protocolVersion ?? "?"}) in ${result.ms ?? server?.probe?.ms ?? "?"} ms with ${server?.probe?.toolCount ?? 0} tool(s).\n${toolLines}`,
          };
        },
      }),
    "mcp-manager: mcp_probe tool",
  );

  ctx.effect(
    () =>
      tools.register({
        name: "mcp_save_server",
        description:
          "Create or update a server in the MCP Manager pool. The pool is the plugin's own store; it does not write to other applications' config files. Supply a stdio command or an http/sse url. Use mcp_export_config to hand the JSON to another client.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Display name, unique in the pool." },
            transport: { type: "string", enum: ["stdio", "http", "sse"], description: "Defaults to http when a url is given, stdio otherwise." },
            command: { type: "string", description: "Executable for stdio servers." },
            args: { type: "array", items: { type: "string" }, description: "Arguments for the command." },
            url: { type: "string", description: "MCP endpoint for http/sse servers." },
            env: { type: "object", additionalProperties: { type: "string" }, description: "Environment variables for stdio servers." },
            headers: { type: "object", additionalProperties: { type: "string" }, description: "HTTP headers for remote servers." },
            note: { type: "string", description: "Short free-form note." },
            enabled: { type: "boolean", description: "Defaults to true." },
          },
          required: ["name"],
          additionalProperties: false,
        },
        output: {
          schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
          render: (_args, value) => [{ type: "text", text: String(value?.summary ?? "") }],
        },
        async execute(args) {
          const file = stateFile();
          const state = requireState(await loadState(file));
          const entry = upsertFromBody(state, args ?? {});
          await saveState(file, state);
          return { summary: `Saved "${entry.name}" [${entry.transport}] in the MCP Manager pool.` };
        },
      }),
    "mcp-manager: mcp_save_server tool",
  );

  ctx.effect(
    () =>
      tools.register({
        name: "mcp_remove_server",
        description: "Move a server from the MCP Manager pool to the trash. Servers discovered in other applications' config files are read-only and are not affected.",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "Exact pool server name." } },
          required: ["name"],
          additionalProperties: false,
        },
        output: {
          schema: { type: "object", properties: { ok: { type: "boolean" }, summary: { type: "string" } }, required: ["ok", "summary"] },
          render: (_args, value) => [{ type: "text", text: String(value?.summary ?? "") }],
        },
        async execute(args) {
          const file = stateFile();
          const state = requireState(await loadState(file));
          const name = String(args?.name ?? "").toLowerCase();
          const entry = Object.values(state.servers).find((item) => item.name.toLowerCase() === name);
          if (!entry) return { ok: false, summary: `No pool server named "${args?.name}".` };
          delete state.servers[entry.id];
          state.trash[entry.id] = { ...entry, deletedAt: new Date().toISOString() };
          await saveState(file, state);
          return { ok: true, summary: `Moved "${entry.name}" to the trash.` };
        },
      }),
    "mcp-manager: mcp_remove_server tool",
  );

  ctx.effect(
    () =>
      tools.register({
        name: "mcp_export_config",
        description:
          "Export servers from the MCP Manager pool as a config snippet for another client: a generic `mcpServers` JSON document, VS Code `servers` JSON, or Codex `config.toml`. Nothing is written to disk; the text is returned for the user to paste.",
        parameters: {
          type: "object",
          properties: {
            format: { type: "string", enum: ["json", "vscode", "codex"], description: "Target dialect. Default json." },
            names: { type: "array", items: { type: "string" }, description: "Pool server names to export. Omit for every server in the pool." },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: "object",
            properties: { count: { type: "number" }, format: { type: "string" }, text: { type: "string" }, summary: { type: "string" } },
            required: ["count", "format", "text", "summary"],
          },
          render: (_args, value) => [{ type: "text", text: String(value?.summary ?? "") }, { type: "text", text: String(value?.text ?? "") }],
        },
        async execute(args) {
          const state = requireState(await loadState(stateFile()));
          const format = ["json", "vscode", "codex"].includes(args?.format) ? args.format : "json";
          const wanted = Array.isArray(args?.names) ? args.names.map((name) => String(name).toLowerCase()) : null;
          const entries = Object.values(state.servers).filter((entry) => !wanted || wanted.includes(entry.name.toLowerCase()));
          const text = exportConfig(format, entries);
          return { count: entries.length, format, text, summary: `Exported ${entries.length} pool server(s) as ${format}.` };
        },
      }),
    "mcp-manager: mcp_export_config tool",
  );
}

/* ---------------------------------------------------------------- apply --- */

export function apply(ctx, config = {}) {
  const log = (message, error) => {
    try {
      const logger = ctx.logger?.("mcp-manager");
      if (logger) {
        if (error) logger.warn(message, error);
        else logger.info?.(message);
        return;
      }
    } catch {}
    if (error) console.warn(`[mcp-manager] ${message}`, error);
  };

  try {
    registerTools(ctx);
  } catch (error) {
    log("failed to register agent tools", error);
  }

  ctx.effect(() => {
    const disposers = [];
    const routes = [
      {
        path: `${API_PREFIX}/state`,
        methods: ["GET", "HEAD"],
        requestBody: "buffered",
        fetch: async (request) =>
          runTask(async () => {
            const url = new URL(request.url);
            const workspace = url.searchParams.get("workspace") ?? undefined;
            return { snapshot: await buildSnapshot(ctx, { workspace }) };
          }),
      },
      {
        path: `${API_PREFIX}/action`,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: (request) => handleAction(ctx, request),
      },
    ];

    const registerFetch = ctx.connection?.fetch?.register;
    if (typeof registerFetch === "function") {
      for (const route of routes) {
        try {
          disposers.push(
            registerFetch.call(ctx.connection.fetch, {
              path: route.path,
              methods: route.methods,
              requestBody: route.requestBody,
              fetch: route.fetch,
            }),
          );
        } catch (error) {
          log(`failed to register route ${route.path}`, error);
        }
      }
    }

    let webServer;
    try {
      webServer = ctx.webServer;
    } catch {
      webServer = undefined;
    }
    if (!disposers.length && webServer && typeof webServer.register === "function") {
      try {
        disposers.push(
          webServer.register({
            kind: "prefix",
            path: API_PREFIX,
            handler: (req, res) => adaptNodeRequest(routes, req, res),
          }),
        );
      } catch (error) {
        log("failed to register fallback web routes", error);
      }
    }

    if (!disposers.length) log("no HTTP carrier available; the settings page will not load data");

    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {}
      }
    };
  }, "mcp-manager: API routes");

  log(`ready (state: ${shortPath(stateFile())})`);
}

/** Adapts a Node request/response pair to the same fetch handler used by the carrier. */
function adaptNodeRequest(routes, req, res) {
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size <= MAX_BODY) chunks.push(chunk);
  });
  req.on("end", async () => {
    const origin = ctx_origin(req);
    const url = new URL(req.url ?? "/", origin);
    const route = routes.find((item) => item.path === url.pathname);
    const send = (response) => {
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (req.method === "HEAD") res.end();
      else response.text().then((text) => res.end(text)).catch(() => res.end());
    };
    if (!route) {
      send(jsonResponse(404, { ok: false, error: "not found" }));
      return;
    }
    if (!route.methods.includes(req.method ?? "GET")) {
      send(jsonResponse(405, { ok: false, error: "method not allowed" }));
      return;
    }
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) headers.set(key, value.join(", "));
        else if (value !== undefined) headers.set(key, String(value));
      }
      const body = ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : Buffer.concat(chunks);
      const response = await route.fetch(new Request(url.toString(), { method: req.method, headers, body }));
      send(response);
    } catch (error) {
      send(jsonResponse(500, { ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  });
}

function ctx_origin(req) {
  const host = req.headers?.host ?? "127.0.0.1";
  const proto = String(req.headers?.["x-forwarded-proto"] ?? "http").split(",")[0].trim();
  return `${proto}://${host}`;
}
