import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { isPlainObject } from "./parse.js";

export const STATE_VERSION = 1;

export function emptyState() {
  return {
    version: STATE_VERSION,
    updatedAt: new Date().toISOString(),
    servers: {},
    trash: {},
    probes: {},
    // Per-chat exposure overrides: sessions[sessionId][serverId] = true|false.
    // A chat's own choice always wins over the pool-wide `expose` flag.
    sessions: {},
  };
}

export function newId() {
  return randomBytes(6).toString("hex");
}

function normalizeEntry(id, raw) {
  const entry = isPlainObject(raw) ? raw : {};
  return {
    id,
    name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : "unnamed",
    transport: ["stdio", "http", "sse"].includes(entry.transport) ? entry.transport : "stdio",
    command: typeof entry.command === "string" ? entry.command : "",
    args: Array.isArray(entry.args) ? entry.args.filter((item) => typeof item === "string") : [],
    env: isPlainObject(entry.env) ? entry.env : {},
    cwd: typeof entry.cwd === "string" ? entry.cwd : "",
    url: typeof entry.url === "string" ? entry.url : "",
    headers: isPlainObject(entry.headers) ? entry.headers : {},
    enabled: entry.enabled !== false,
    expose: entry.expose === true,
    note: typeof entry.note === "string" ? entry.note : "",
    tags: Array.isArray(entry.tags) ? entry.tags.filter((item) => typeof item === "string") : [],
    createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
    updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date().toISOString(),
    probe: isPlainObject(entry.probe) ? entry.probe : null,
  };
}

export function normalizeState(raw) {
  const state = emptyState();
  if (!isPlainObject(raw)) return state;
  if (isPlainObject(raw.servers)) {
    for (const [id, entry] of Object.entries(raw.servers)) state.servers[id] = normalizeEntry(id, entry);
  }
  if (isPlainObject(raw.trash)) {
    for (const [id, entry] of Object.entries(raw.trash)) {
      state.trash[id] = { ...normalizeEntry(id, entry), deletedAt: entry?.deletedAt ?? new Date().toISOString() };
    }
  }
  if (isPlainObject(raw.probes)) {
    for (const [key, entry] of Object.entries(raw.probes)) {
      if (isPlainObject(entry)) state.probes[key] = { specHash: entry.specHash, at: entry.at, probe: isPlainObject(entry.probe) ? entry.probe : null };
    }
  }
  if (isPlainObject(raw.sessions)) {
    for (const [sessionId, overrides] of Object.entries(raw.sessions)) {
      if (!isPlainObject(overrides)) continue;
      const clean = {};
      for (const [serverId, value] of Object.entries(overrides)) {
        if (typeof value === "boolean") clean[serverId] = value;
      }
      if (Object.keys(clean).length) state.sessions[sessionId] = clean;
    }
  }
  if (typeof raw.updatedAt === "string") state.updatedAt = raw.updatedAt;
  return state;
}

export async function loadState(file) {
  try {
    const text = await readFile(file, "utf8");
    return normalizeState(JSON.parse(text));
  } catch (error) {
    if (error && error.code === "ENOENT") return emptyState();
    // A damaged state file must not take the whole page down: start empty and let the
    // next write replace it.
    return { ...emptyState(), corrupt: error instanceof Error ? error.message : String(error) };
  }
}

export async function saveState(file, state) {
  await mkdir(path.dirname(file), { recursive: true });
  const next = { ...state, version: STATE_VERSION, updatedAt: new Date().toISOString() };
  delete next.corrupt;
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  try {
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  return next;
}
