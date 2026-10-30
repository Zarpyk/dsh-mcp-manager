import { createHash } from "node:crypto";

const STDIO_TYPES = new Set(["stdio", "local", "process", "subprocess"]);
const HTTP_TYPES = new Set(["http", "streamable-http", "streamablehttp", "streamable", "remote", "http-stream"]);
const SSE_TYPES = new Set(["sse", "legacy-sse", "server-sent-events"]);

const SECRET_KEY = /(key|token|secret|password|passwd|auth|credential|bearer|session)/i;

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function safeJsonParse(text) {
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/* ------------------------------------------------------------------ TOML --- */

function stripTomlComment(line) {
  let quote = "";
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (char === "\\" && quote === '"') i += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "#") return line.slice(0, i);
  }
  return line;
}

function unescapeTomlString(body) {
  return body.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, escape) => {
    if (escape.length === 5 && escape[0] === "u") return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    switch (escape) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "b": return "\b";
      case "f": return "\f";
      case '"': return '"';
      case "\\": return "\\";
      default: return escape;
    }
  });
}

function splitTopLevel(body, separator) {
  const parts = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (quote) {
      if (char === "\\" && quote === '"') i += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/** Parses the subset of TOML that MCP client configs use: tables, string / number /
 *  boolean / array / inline-table values, and dotted keys. */
export function parseToml(text) {
  const root = {};
  let current = root;
  const lines = String(text).split(/\r?\n/);

  const ensureTable = (container, keys) => {
    let node = container;
    for (const key of keys) {
      if (!isPlainObject(node[key])) node[key] = {};
      node = node[key];
    }
    return node;
  };

  const splitKeyPath = (raw) => splitTopLevel(raw.replace(/^\[\[?|\]\]?$/g, ""), ".").map((part) => part.trim().replace(/^["']|["']$/g, "")).filter(Boolean);

  for (let index = 0; index < lines.length; index += 1) {
    let line = stripTomlComment(lines[index]).trim();
    if (!line) continue;

    if (line.startsWith("[")) {
      const arrayTable = line.startsWith("[[");
      const keys = splitKeyPath(line);
      if (!keys.length) continue;
      const parent = ensureTable(root, keys.slice(0, -1));
      const leaf = keys[keys.length - 1];
      if (arrayTable) {
        if (!Array.isArray(parent[leaf])) parent[leaf] = [];
        const entry = {};
        parent[leaf].push(entry);
        current = entry;
      } else {
        current = ensureTable(parent, [leaf]);
      }
      continue;
    }

    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, "");
    let valueText = line.slice(eq + 1).trim();

    // Continue multi-line arrays / inline tables until brackets balance.
    let guard = 0;
    while (!balanced(valueText) && index + 1 < lines.length && guard < 200) {
      index += 1;
      guard += 1;
      valueText += `\n${stripTomlComment(lines[index]).trim()}`;
    }

    const value = parseTomlValue(valueText);
    if (key.includes(".")) {
      const parts = splitKeyPath(key);
      ensureTable(current, parts.slice(0, -1))[parts[parts.length - 1]] = value;
    } else {
      current[key] = value;
    }
  }

  return root;
}

function balanced(text) {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === "\\" && quote === '"') i += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
  }
  return depth <= 0 && !quote;
}

function parseTomlValue(text) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
    return trimmed.slice(3, -3);
  }
  if (trimmed.startsWith('"')) {
    const end = findClosingQuote(trimmed, '"');
    return unescapeTomlString(trimmed.slice(1, end));
  }
  if (trimmed.startsWith("'")) {
    const end = findClosingQuote(trimmed, "'");
    return trimmed.slice(1, end);
  }
  if (trimmed.startsWith("[")) {
    const body = trimmed.replace(/^\[/, "").replace(/\]$/, "");
    return splitTopLevel(body, ",").map((part) => part.trim()).filter(Boolean).map(parseTomlValue);
  }
  if (trimmed.startsWith("{")) {
    const body = trimmed.replace(/^\{/, "").replace(/\}$/, "");
    const table = {};
    for (const part of splitTopLevel(body, ",")) {
      const item = part.trim();
      if (!item) continue;
      const eq = item.indexOf("=");
      if (eq < 0) continue;
      table[item.slice(0, eq).trim().replace(/^["']|["']$/g, "")] = parseTomlValue(item.slice(eq + 1));
    }
    return table;
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const number = trimmed.replace(/_/g, "");
  if (/^[+-]?\d+$/.test(number)) return Number.parseInt(number, 10);
  if (/^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(number)) return Number.parseFloat(number);
  return trimmed;
}

function findClosingQuote(text, quote) {
  for (let i = 1; i < text.length; i += 1) {
    if (text[i] === "\\" && quote === '"') i += 1;
    else if (text[i] === quote) return i;
  }
  return text.length;
}

/* -------------------------------------------------------------- SHAPES --- */

function container(doc) {
  if (!isPlainObject(doc)) return undefined;
  for (const key of ["mcpServers", "mcp_servers", "servers"]) {
    if (isPlainObject(doc[key])) return doc[key];
  }
  if (isPlainObject(doc.mcp) && isPlainObject(doc.mcp.servers)) return doc.mcp.servers;
  if (isPlainObject(doc.mcp)) return doc.mcp;
  if (typeof doc["amp.mcpServers"] === "object" && isPlainObject(doc["amp.mcpServers"])) return doc["amp.mcpServers"];
  if (isPlainObject(doc.context_servers)) return doc.context_servers;
  if (isPlainObject(doc.extensions)) return doc.extensions;
  return undefined;
}

/** Document -> [{ name, raw }] for one config format. */
export function extractEntries(doc, format) {
  if (format === "connector") return connectorEntries(doc);
  const servers = container(doc);
  if (!isPlainObject(servers)) return [];
  return Object.entries(servers)
    .filter(([, raw]) => isPlainObject(raw))
    .map(([name, raw]) => ({ name, raw }));
}

function connectorEntries(doc) {
  const connections = doc?.tables?.connections;
  if (!isPlainObject(connections)) return [];
  const entries = [];
  for (const [key, record] of Object.entries(connections)) {
    if (!isPlainObject(record)) continue;
    const server = isPlainObject(record.server) ? record.server : isPlainObject(record.config?.server) ? record.config.server : isPlainObject(record.definition) ? record.definition : record;
    const name = (typeof record.name === "string" && record.name.trim()) || (typeof server.name === "string" && server.name.trim()) || key;
    entries.push({ name, raw: server });
  }
  return entries;
}

/* --------------------------------------------------------- NORMALIZE --- */

function firstString(...values) {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return "";
}

function stringArray(value) {
  if (Array.isArray(value)) return value.map((item) => (typeof item === "string" ? item : String(item ?? ""))).filter(Boolean);
  if (typeof value === "string" && value.trim()) return value.trim().split(/\s+/);
  return [];
}

function stringMap(value) {
  if (!isPlainObject(value)) return {};
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null) continue;
    out[key] = typeof entry === "string" ? entry : String(entry);
  }
  return out;
}

export function detectTransport(type, command, url) {
  const kind = typeof type === "string" ? type.trim().toLowerCase() : "";
  if (SSE_TYPES.has(kind)) return "sse";
  if (HTTP_TYPES.has(kind)) return "http";
  if (STDIO_TYPES.has(kind)) return "stdio";
  if (url && !command) return "http";
  if (command) return "stdio";
  return "unknown";
}

/** Raw config entry -> normalized server spec, tolerant across client dialects. */
export function normalizeEntry(name, raw, format) {
  const entry = isPlainObject(raw) ? raw : {};
  let command = "";
  let args = [];
  let env = {};
  let cwd = "";
  let url = "";
  let headers = {};
  let type = "";

  if (format === "opencode") {
    type = firstString(entry.type);
    const parts = stringArray(entry.command);
    command = parts[0] ?? "";
    args = parts.slice(1);
    env = stringMap(entry.environment ?? entry.env);
    url = firstString(entry.url, entry.serverUrl);
    headers = stringMap(entry.headers);
    cwd = firstString(entry.cwd);
  } else if (format === "zed") {
    if (isPlainObject(entry.command)) {
      command = firstString(entry.command.path, entry.command.command);
      args = stringArray(entry.command.args);
      env = stringMap(entry.command.env);
      cwd = firstString(entry.command.cwd);
    } else {
      command = firstString(entry.command);
      args = stringArray(entry.args);
      env = stringMap(entry.env);
    }
    url = firstString(entry.url, entry.serverUrl, entry.endpoint);
    headers = stringMap(entry.headers);
    type = firstString(entry.type, entry.transport);
  } else if (format === "codex") {
    command = firstString(entry.command);
    args = stringArray(entry.args);
    env = stringMap(entry.env);
    cwd = firstString(entry.cwd);
    url = firstString(entry.url, entry.server_url);
    headers = stringMap(entry.http_headers ?? entry.headers);
    type = firstString(entry.type, entry.transport);
  } else if (format === "connector") {
    const spec = isPlainObject(entry.transport) ? entry.transport : entry;
    type = typeof entry.transport === "string" ? entry.transport : firstString(spec.type, spec.kind, entry.type);
    command = firstString(spec.command, entry.command);
    args = stringArray(spec.args ?? entry.args);
    env = stringMap(spec.env ?? entry.env);
    cwd = firstString(spec.cwd, entry.cwd);
    url = firstString(spec.url, spec.serverUrl, entry.url, entry.serverUrl);
    headers = stringMap(spec.headers ?? entry.headers);
  } else {
    type = firstString(entry.type, entry.transport, entry.kind);
    command = firstString(entry.command);
    args = stringArray(entry.args);
    env = stringMap(entry.env ?? entry.environment);
    cwd = firstString(entry.cwd);
    url = firstString(entry.url, entry.serverUrl, entry.endpoint, entry.httpUrl);
    headers = stringMap(entry.headers ?? entry.httpHeaders ?? entry.http_headers);
  }

  const transport = detectTransport(type, command, url);
  const enabled = entry.enabled === false ? false : entry.disabled === true ? false : true;

  return {
    name,
    type: type || transport,
    transport,
    command,
    args,
    env,
    cwd,
    url,
    headers,
    enabled,
  };
}

/** Stable identity for one normalized spec, used for change detection. */
export function specHash(spec) {
  return createHash("sha1")
    .update(
      JSON.stringify([
        spec.transport,
        spec.command,
        spec.args,
        Object.entries(spec.env ?? {}).sort(),
        spec.cwd,
        spec.url,
        Object.entries(spec.headers ?? {}).sort(),
        spec.enabled,
      ]),
    )
    .digest("hex")
    .slice(0, 12);
}

export function maskValue(value) {
  const text = String(value ?? "");
  if (!text) return "";
  if (text.length <= 8) return "••••••";
  return `••••••${text.slice(-4)}`;
}

/** Display copy with secret-looking environment / header values redacted. */
export function maskedSpec(spec) {
  const mask = (map) => {
    const out = {};
    for (const [key, value] of Object.entries(map ?? {})) out[key] = SECRET_KEY.test(key) ? maskValue(value) : value;
    return out;
  };
  return {
    transport: spec.transport,
    type: spec.type,
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    url: redactUrl(spec.url),
    env: mask(spec.env),
    headers: mask(spec.headers),
    enabled: spec.enabled,
  };
}

/** Display copy of a URL with credential-looking parts replaced (ASCII only, so it
 *  survives URL re-serialization). */
export function redactUrl(value) {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    for (const key of [...parsed.searchParams.keys()]) {
      if (SECRET_KEY.test(key)) parsed.searchParams.set(key, "***");
    }
    if (parsed.username) parsed.username = "***";
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return value;
  }
}

/** One-line human description of how a server is reached. */
export function describeSpec(spec) {
  if (spec.transport === "stdio") return [spec.command, ...(spec.args ?? [])].filter(Boolean).join(" ");
  return redactUrl(spec.url);
}
