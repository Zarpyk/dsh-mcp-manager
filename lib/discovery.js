import { readFile, stat } from "node:fs/promises";
import {
  describeSpec,
  extractEntries,
  isPlainObject,
  maskedSpec,
  normalizeEntry,
  parseToml,
  redactUrl,
  safeJsonParse,
  specHash,
} from "./parse.js";
import { projectSources, shortPath, userSources } from "./sources.js";

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

function parseDocument(text, format) {
  if (format === "codex") return { value: parseToml(text) };
  return safeJsonParse(text);
}

/** Reads one config file and normalizes every server it declares. */
export async function scanFile(source, scope) {
  const base = {
    id: source.id,
    label: source.label,
    app: source.app,
    format: source.format,
    file: source.file,
    path: shortPath(source.file),
    scope,
    note: source.note,
  };

  let info;
  try {
    info = await stat(source.file);
  } catch {
    return { source: { ...base, exists: false, count: 0 }, servers: [] };
  }
  if (!info.isFile()) return { source: { ...base, exists: false, count: 0 }, servers: [] };
  if (info.size > MAX_CONFIG_BYTES) {
    return {
      source: { ...base, exists: true, count: 0, error: "file is larger than 4 MB; skipped", size: info.size },
      servers: [],
    };
  }

  let text;
  try {
    text = await readFile(source.file, "utf8");
  } catch (error) {
    return {
      source: { ...base, exists: true, count: 0, error: `cannot read file: ${error instanceof Error ? error.message : String(error)}` },
      servers: [],
    };
  }

  const parsed = parseDocument(text, source.format);
  if (parsed.error) {
    return { source: { ...base, exists: true, count: 0, error: `invalid ${source.format === "codex" ? "TOML" : "JSON"}: ${parsed.error}`, size: info.size }, servers: [] };
  }
  if (!isPlainObject(parsed.value)) {
    return { source: { ...base, exists: true, count: 0, error: "config root is not an object", size: info.size }, servers: [] };
  }

  const entries = extractEntries(parsed.value, source.format);
  const servers = entries.map(({ name, raw }) => {
    const spec = normalizeEntry(name, raw, source.format);
    return {
      key: `${source.id}#${name}`,
      name,
      managed: false,
      sourceId: source.id,
      sourceLabel: source.label,
      sourceApp: source.app,
      sourcePath: shortPath(source.file),
      file: source.file,
      scope,
      workspace: source.project ? source.workspace : null,
      format: source.format,
      transport: spec.transport,
      type: spec.type,
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      url: redactUrl(spec.url),
      envKeys: Object.keys(spec.env),
      headerKeys: Object.keys(spec.headers),
      enabled: spec.enabled,
      specHash: specHash(spec),
      display: describeSpec(spec),
      readable: true,
      raw: maskedSpec(spec),
      spec,
    };
  });

  return {
    source: { ...base, exists: true, count: servers.length, size: info.size, updatedAt: info.mtime.toISOString() },
    servers,
  };
}

/** User-level config files followed by every project config of the given workspaces. */
export async function scanAll({ workspaces = [] } = {}) {
  const jobs = [];
  for (const source of userSources()) jobs.push({ source, scope: "user" });
  for (const workspace of workspaces) {
    for (const source of projectSources(workspace)) jobs.push({ source: { ...source, workspace }, scope: "project" });
  }

  const results = await Promise.all(jobs.map((job) => scanFile(job.source, job.scope)));
  const sources = results.map((result) => result.source);
  const servers = [];
  for (const result of results) {
    for (const server of result.servers) {
      if (servers.some((entry) => entry.key === server.key)) continue;
      servers.push(server);
    }
  }
  return { sources, servers, scannedAt: new Date().toISOString() };
}
