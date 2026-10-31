import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const CLIENT_INFO = { name: "dsh-mcp-manager", version: "1.3.2" };

const MAX_STDOUT = 2 * 1024 * 1024;
const MAX_TOOLS = 500;

/* ------------------------------------------------------------- helpers --- */

function nowIso() {
  return new Date().toISOString();
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(message), { code: "ETIMEDOUT" })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function tail(text, limit = 600) {
  const value = String(text ?? "").trim();
  return value.length > limit ? `…${value.slice(-limit)}` : value;
}

function jsonrpcError(message) {
  const error = new Error(`${message.message ?? "MCP error"}${message.code !== undefined ? ` (${message.code})` : ""}`);
  error.code = message.code;
  error.rpc = message;
  return error;
}

export function hintFor(error) {
  const message = String(error?.message ?? error ?? "");
  const code = error?.code;
  if (code === "ENOENT" || /ENOENT|not recognized|no such file/i.test(message)) return "Command not found. Check the executable name or install it first.";
  if (code === "ETIMEDOUT" || /timed out|timeout/i.test(message)) return "No answer in time. The server may be slow to start, or the endpoint is unreachable.";
  if (/\b401\b|\b403\b|unauthorized|forbidden/i.test(message)) return "The endpoint rejected the request. Add an Authorization header to the server entry.";
  if (/\b404\b/.test(message)) return "Endpoint not found. Verify the URL path of the MCP endpoint.";
  if (/ECONNREFUSED/i.test(message)) return "Connection refused. Is the server running on that port?";
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return "Host not found. Check the URL hostname and your network.";
  if (/certificate|self-signed|SSL|TLS/i.test(message)) return "TLS problem. Check the certificate chain of the endpoint.";
  if (/Unsupported protocol version/i.test(message)) return "The server only supports an older MCP protocol version.";
  return undefined;
}

/* ---------------------------------------------------------- transport --- */

function quoteCmdArg(value) {
  const text = String(value ?? "");
  if (!text) return '""';
  if (!/[\s"&|<>^%]/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function resolveWindowsCommand(command) {
  if (path.isAbsolute(command) || command.includes("\\") || command.includes("/")) return command;
  const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, command + extension.toLowerCase());
      if (existsFile(candidate)) return candidate;
    }
    const plain = path.join(dir, command);
    if (existsFile(plain)) return plain;
  }
  return undefined;
}

function existsFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function buildSpawn(command, args) {
  if (process.platform !== "win32") return { file: command, argv: args, verbatim: false };
  const resolved = resolveWindowsCommand(command) ?? command;
  if (/\.(exe|com)$/i.test(resolved)) return { file: resolved, argv: args, verbatim: false };
  if (process.env.ComSpec && /\.(cmd|bat)$/i.test(resolved)) {
    const line = [resolved, ...args].map(quoteCmdArg).join(" ");
    return { file: process.env.ComSpec, argv: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
  }
  return { file: resolved, argv: args, verbatim: false };
}

/* ------------------------------------------------------------- framing --- */

/** Newline-delimited JSON-RPC over a child process. */
export class StdioChannel {
  constructor(spec, timeoutMs, onNotification) {
    this.spec = spec;
    this.timeoutMs = timeoutMs;
    this.onNotification = onNotification;
    this.buffer = "";
    this.stderr = "";
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
  }

  async start() {
    const env = { ...process.env, ...(this.spec.env ?? {}) };
    const cwd = this.spec.cwd
      ? this.spec.cwd.startsWith("~")
        ? path.join(homedir(), this.spec.cwd.slice(1))
        : this.spec.cwd
      : process.cwd();
    const { file, argv, verbatim } = buildSpawn(this.spec.command, this.spec.args ?? []);
    this.child = spawn(file, argv, {
      cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => {
      if (!this.closed) {
        this.fail(
          Object.assign(new Error(`server exited (code ${code}${signal ? `, ${signal}` : ""})${this.stderr ? `: ${tail(this.stderr)}` : ""}`), {
            code: "EEXITED",
          }),
        );
      }
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-8192);
    });
    this.child.stdin.on("error", () => {});
  }

  onData(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_STDOUT) {
      this.fail(new Error("server produced too much output"));
      return;
    }
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "").trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line || !line.startsWith("{")) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.dispatch(message);
    }
  }

  dispatch(message) {
    if (message && typeof message.id === "number" && this.pending.has(message.id)) {
      const settle = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) settle.reject(jsonrpcError(message.error));
      else settle.resolve(message.result);
      return;
    }
    if (message && typeof message.method === "string" && message.id !== undefined) {
      // Answer server-initiated pings so a handshake is not stalled by them.
      this.write({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }
    if (message && typeof message.method === "string" && message.id === undefined) {
      // Notifications (tools/list_changed, logging, progress) drive live refresh.
      try {
        this.onNotification?.(message);
      } catch {
        /* a broken listener must not kill the channel */
      }
    }
  }

  write(message) {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    const answer = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write(message);
    });
    return withTimeout(answer, this.timeoutMs, `${method} timed out`);
  }

  notify(method, params) {
    const message = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    this.write(message);
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const [, settle] of this.pending) settle.reject(error);
    this.pending.clear();
  }

  async stop() {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    for (const [, settle] of this.pending) settle.reject(new Error("probe finished"));
    this.pending.clear();
    try {
      child.stdin?.end();
    } catch {}
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    if (process.platform === "win32" && child.pid) {
      try {
        spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `taskkill /pid ${child.pid} /T /F`], {
          windowsHide: true,
          stdio: "ignore",
        });
      } catch {}
    }
    await withTimeout(exited, 1500, "kill timed out").catch(() => {});
  }
}

/* --------------------------------------------------------------- HTTP --- */

function parseSseMessages(text) {
  const messages = [];
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data.trim()) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      /* keep scanning: a server may emit non-JSON keep-alive payloads */
    }
  }
  return messages;
}

function looksLikeSse(text, contentType) {
  if (String(contentType ?? "").includes("text/event-stream")) return true;
  const head = String(text ?? "").trimStart();
  return head.startsWith("event:") || head.startsWith("data:") || head.startsWith("id:");
}

export async function postJson(url, headers, message, timeoutMs) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  const sessionId = response.headers.get("mcp-session-id") ?? undefined;
  if (!response.ok) {
    throw Object.assign(new Error(`HTTP ${response.status} ${tail(text, 240)}`), { status: response.status });
  }
  if (!text.trim()) return { messages: [], sessionId };
  if (looksLikeSse(text, response.headers.get("content-type"))) return { messages: parseSseMessages(text), sessionId };
  try {
    return { messages: [JSON.parse(text)], sessionId };
  } catch {
    throw new Error(`unexpected response body: ${tail(text, 240)}`);
  }
}

async function callHttp(url, headers, message, timeoutMs) {
  const { messages } = await postJson(url, headers, message, timeoutMs);
  if (!messages.length) throw new Error("empty response from MCP endpoint");
  const id = message.id;
  const reply = messages.find((entry) => entry && entry.id === id) ?? messages.find((entry) => entry && (entry.result || entry.error));
  if (!reply) throw new Error("response did not contain a JSON-RPC reply");
  if (reply.error) throw jsonrpcError(reply.error);
  return reply.result;
}

function isProtocolVersionRejection(error) {
  return /Unsupported protocol version|protocol version/i.test(String(error?.message ?? ""));
}

async function probeHttp(spec, timeoutMs) {
  const headers = { ...(spec.headers ?? {}) };
  let lastError;
  let session;
  let initReply;
  for (const version of PROTOCOL_VERSIONS) {
    try {
      session = await postJson(
        spec.url,
        headers,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: version, capabilities: { roots: { listChanged: false }, tools: {} }, clientInfo: CLIENT_INFO },
        },
        timeoutMs,
      );
      const reply = session.messages.find((entry) => entry?.id === 1);
      if (!reply) throw new Error("initialize produced no reply");
      if (reply.error) throw jsonrpcError(reply.error);
      initReply = reply;
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      if (!isProtocolVersionRejection(error)) throw error;
    }
  }
  if (lastError) throw lastError;
  if (!initReply) throw new Error("initialize produced no reply");

  const activeHeaders = { ...headers };
  if (session.sessionId) activeHeaders["mcp-session-id"] = session.sessionId;
  if (initReply.result?.protocolVersion) activeHeaders["mcp-protocol-version"] = initReply.result.protocolVersion;

  await postJson(spec.url, activeHeaders, { jsonrpc: "2.0", method: "notifications/initialized" }, timeoutMs).catch(() => {});
  const tools = await listTools((message) => callHttp(spec.url, activeHeaders, message, timeoutMs));
  return { ...summarize(initReply.result), tools };
}

/* --------------------------------------------------------- legacy SSE --- */

async function probeLegacySse(spec, timeoutMs) {
  const controller = new AbortController();
  const response = await fetch(spec.url, {
    headers: { accept: "text/event-stream", ...(spec.headers ?? {}) },
    signal: controller.signal,
  });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} opening event stream`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let endpoint;
  const queue = [];

  const pump = async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const lf = buffer.indexOf("\n\n");
        const crlf = buffer.indexOf("\r\n\r\n");
        let index = -1;
        let width = 2;
        if (lf >= 0 && (crlf < 0 || lf < crlf)) {
          index = lf;
          width = 2;
        } else if (crlf >= 0) {
          index = crlf;
          width = 4;
        }
        if (index < 0) break;
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + width);
        const event = { event: "message", data: "" };
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("event:")) event.event = line.slice(6).trim();
          else if (line.startsWith("data:")) event.data += `${line.slice(5).replace(/^ /, "")}\n`;
        }
        if (event.event === "endpoint") endpoint = event.data.trim();
        else if (event.data.trim()) {
          try {
            const parsed = JSON.parse(event.data.trim());
            const waiter = queue.findIndex((item) => !item.id || item.id === parsed.id);
            if (waiter >= 0) {
              const [item] = queue.splice(waiter, 1);
              if (parsed.error) item.reject(jsonrpcError(parsed.error));
              else item.resolve(parsed.result);
            }
          } catch {}
        }
      }
    }
  };
  const pumpPromise = pump().catch((error) => {
    for (const item of queue.splice(0)) item.reject(error);
  });

  const waitFor = (id) =>
    withTimeout(
      new Promise((resolve, reject) => queue.push({ id, resolve, reject })),
      timeoutMs,
      "MCP message timed out",
    );

  try {
    await withTimeout(
      (async () => {
        while (!endpoint) await new Promise((resolve) => setTimeout(resolve, 50));
      })(),
      timeoutMs,
      "event stream did not send an endpoint",
    );

    const postUrl = new URL(endpoint, spec.url).toString();
    const send = (message) =>
      fetch(postUrl, {
        method: "POST",
        headers: { "content-type": "application/json", ...(spec.headers ?? {}) },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(timeoutMs),
      }).then(async (reply) => {
        if (!reply.ok) throw new Error(`HTTP ${reply.status} posting to event stream`);
        await reply.text().catch(() => {});
      });

    const initAnswer = waitFor(1);
    await send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: CLIENT_INFO },
    });
    const initialized = await initAnswer;
    await send({ jsonrpc: "2.0", method: "notifications/initialized" });

    let id = 1;
    const tools = await listTools(async (message) => {
      id += 1;
      const envelope = { ...message, id };
      const answer = waitFor(id);
      await send(envelope);
      return answer;
    });
    return { ...summarize(initialized), tools };
  } finally {
    controller.abort();
    pumpPromise.catch(() => {});
  }
}

/* --------------------------------------------------------- stdio probe --- */

async function probeStdio(spec, timeoutMs) {
  const channel = new StdioChannel(spec, timeoutMs);
  try {
    await channel.start();
    const initialized = await channel.request("initialize", {
      protocolVersion: PROTOCOL_VERSIONS[0],
      capabilities: { roots: { listChanged: false }, tools: {} },
      clientInfo: CLIENT_INFO,
    });
    channel.notify("notifications/initialized");
    const tools = await listTools((message) => channel.request(message.method, message.params));
    return { ...summarize(initialized), tools };
  } finally {
    await channel.stop();
  }
}

/* -------------------------------------------------------------- shared --- */

async function listTools(call) {
  const collected = [];
  let cursor;
  for (let page = 0; page < 20; page += 1) {
    const params = cursor ? { cursor } : {};
    const result = await call({ jsonrpc: "2.0", id: 2, method: "tools/list", params });
    const pageTools = Array.isArray(result?.tools) ? result.tools : [];
    for (const tool of pageTools) {
      if (!tool || typeof tool.name !== "string") continue;
      collected.push({
        name: tool.name,
        title: typeof tool.title === "string" ? tool.title : undefined,
        description: typeof tool.description === "string" ? tail(tool.description, 400) : undefined,
      });
      if (collected.length >= MAX_TOOLS) return collected;
    }
    cursor = result?.nextCursor;
    if (!cursor || !pageTools.length) break;
  }
  return collected;
}

function summarize(initialized) {
  return {
    serverName: initialized?.serverInfo?.name ?? undefined,
    serverVersion: initialized?.serverInfo?.version ?? undefined,
    protocolVersion: initialized?.protocolVersion ?? undefined,
    instructions: typeof initialized?.instructions === "string" ? tail(initialized.instructions, 500) : undefined,
    capabilities: initialized?.capabilities && typeof initialized.capabilities === "object" ? Object.keys(initialized.capabilities) : [],
  };
}

/* ---------------------------------------------------------------- main --- */

/** Connects to one MCP server, performs the initialize handshake and lists tools. */
export async function probeServer(spec, options = {}) {
  const started = Date.now();
  const timeoutMs = Math.max(1000, Math.min(120000, Number(options.timeoutMs) || (spec.transport === "stdio" ? 30000 : 15000)));
  try {
    if (!spec.transport || spec.transport === "unknown") throw new Error("entry has neither a command nor a URL");
    if (spec.transport === "stdio" && !spec.command) throw new Error("stdio entry has no command");
    if (spec.transport !== "stdio" && !spec.url) throw new Error(`${spec.transport} entry has no URL`);
    const answer =
      spec.transport === "stdio"
        ? await probeStdio(spec, timeoutMs)
        : spec.transport === "sse"
          ? await probeLegacySse(spec, timeoutMs)
          : await probeHttp(spec, timeoutMs);
    return {
      ok: true,
      at: nowIso(),
      ms: Date.now() - started,
      toolCount: answer.tools.length,
      tools: answer.tools,
      serverName: answer.serverName,
      serverVersion: answer.serverVersion,
      protocolVersion: answer.protocolVersion,
      instructions: answer.instructions,
      capabilities: answer.capabilities,
    };
  } catch (error) {
    return {
      ok: false,
      at: nowIso(),
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
      hint: hintFor(error),
    };
  }
}
