/* MCP Manager — settings page for the DSH Harness web client.
 *
 * Plain JavaScript module loaded through window.__ModuleLoader__. It requires
 * React from the browser module table (never bundled) and registers one entry in
 * the `settings.section` slot. The page talks to the host half over the plugin's
 * own HTTP routes under /api/dsh-mcp-manager.
 */
window.__ModuleLoader__.load({
  id: "@zarpyk/dsh-mcp-manager",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const NS = "mcp-manager";
    const API = "/api/dsh-mcp-manager";

    const DICT = {
      en: {
        title: "MCP Manager",
        subtitle: "Inspect, test and manage MCP servers across the tools installed on this machine.",
      },
    };

    /* ------------------------------------------------------------- http --- */

    function pageBaseHref() {
      const base = (typeof document !== "undefined" && document.baseURI) || `${window.location.origin}/`;
      return base.endsWith("/") ? base : `${base}/`;
    }

    function resolveApiUrl(path) {
      try {
        return new URL(String(path).replace(/^\//, ""), pageBaseHref()).toString();
      } catch {
        return path;
      }
    }

    async function parseJson(response) {
      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`The server answered with something that is not JSON (HTTP ${response.status}).`);
      }
      if (payload && payload.ok === false) throw new Error(payload.error || `Request failed (HTTP ${response.status})`);
      if (!payload || payload.ok !== true) throw new Error(payload?.error || `Request failed (HTTP ${response.status})`);
      return payload.data;
    }

    function apiGet(path) {
      return fetch(resolveApiUrl(API + path), { headers: { accept: "application/json" } }).then(parseJson);
    }

    function apiPost(payload) {
      return fetch(resolveApiUrl(`${API}/action`), {
        method: "POST",
        headers: { "content-type": "application/json", "x-dsh-mcp-manager": "1", accept: "application/json" },
        body: JSON.stringify(payload),
      }).then(parseJson);
    }

    async function copyText(text) {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        /* fall through to the legacy path */
      }
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "readonly");
        area.style.position = "fixed";
        area.style.top = "-1000px";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(area);
        return ok;
      } catch {
        return false;
      }
    }

    /* ---------------------------------------------------------- helpers --- */

    function cx(...values) {
      return values.filter(Boolean).join(" ");
    }

    function transportLabel(transport) {
      if (transport === "http") return "HTTP";
      if (transport === "sse") return "SSE";
      if (transport === "stdio") return "stdio";
      return transport || "unknown";
    }

    function timeAgo(iso) {
      if (!iso) return "";
      const then = new Date(iso).getTime();
      if (!Number.isFinite(then)) return "";
      const seconds = Math.round((Date.now() - then) / 1000);
      if (seconds < 45) return "just now";
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return `${minutes} min ago`;
      const hours = Math.round(minutes / 60);
      if (hours < 24) return `${hours} h ago`;
      const days = Math.round(hours / 24);
      if (days < 31) return `${days} d ago`;
      return new Date(iso).toLocaleDateString();
    }

    function formatBytes(size) {
      if (!Number.isFinite(size)) return "";
      if (size < 1024) return `${size} B`;
      if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
      return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    }

    function serverStatus(server) {
      if (!server.enabled) return { kind: "disabled", label: "Disabled" };
      if (!server.probe) return { kind: "untested", label: "Not tested" };
      if (server.probe.ok) {
        const count = server.probe.toolCount ?? 0;
        return { kind: "ok", label: `${count} tool${count === 1 ? "" : "s"}` };
      }
      return { kind: "fail", label: "Failing" };
    }

    function specLines(server) {
      if (server.transport === "stdio") return [server.command, ...(server.args ?? [])].filter(Boolean).join(" ");
      return server.url || "";
    }

    function parsePairs(text) {
      const out = {};
      for (const rawLine of String(text ?? "").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const equals = line.indexOf("=");
        const colon = line.indexOf(":");
        let cut = -1;
        if (equals > 0 && colon > 0) cut = Math.min(equals, colon);
        else cut = equals > 0 ? equals : colon;
        if (cut <= 0) continue;
        const key = line.slice(0, cut).trim();
        const value = line.slice(cut + 1).trim();
        if (key) out[key] = value;
      }
      return out;
    }

    function pairsText(map) {
      return Object.entries(map ?? {})
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");
    }

    function splitList(text) {
      return String(text ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    }

    function snippetFor(server) {
      const spec =
        server.transport === "stdio"
          ? { command: server.command, args: server.args ?? [], ...(Object.keys(server.env ?? {}).length ? { env: server.env } : {}) }
          : { type: server.transport, url: server.url, ...(Object.keys(server.headers ?? {}).length ? { headers: server.headers } : {}) };
      return `${JSON.stringify({ mcpServers: { [server.name]: spec } }, null, 2)}\n`;
    }

    /* --------------------------------------------------------- primitives --- */

    function Button(props) {
      return h(
        "button",
        {
          type: "button",
          className: cx("mcpm-btn", props.variant),
          onClick: props.onClick,
          disabled: props.disabled,
          title: props.title,
          "aria-label": props.ariaLabel ?? props.title,
        },
        props.children,
      );
    }

    function Field(props) {
      return h(
        "div",
        { className: "mcpm-field" },
        h("label", { htmlFor: props.id }, props.label),
        props.children,
        props.hint ? h("div", { className: "mcpm-hint" }, props.hint) : null,
      );
    }

    function Modal(props) {
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === "Escape") props.onClose?.();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [props.onClose]);

      return h(
        "div",
        {
          className: "mcpm-modal-backdrop",
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) props.onClose?.();
          },
        },
        h(
          "div",
          { className: "mcpm-modal", role: "dialog", "aria-modal": "true", "aria-label": props.title },
          h(
            "div",
            { className: "mcpm-modal-head" },
            h("strong", null, props.title),
            h(Button, { variant: "ghost", onClick: props.onClose, title: "Close" }, "Close"),
          ),
          h("div", { className: "mcpm-modal-body" }, props.children),
          props.footer ? h("div", { className: "mcpm-modal-foot" }, props.footer) : null,
        ),
      );
    }

    function Tabs(props) {
      return h(
        "div",
        { className: "mcpm-tabs", role: "tablist" },
        props.items.map((item) =>
          h(
            "button",
            {
              key: item.id,
              type: "button",
              role: "tab",
              className: "mcpm-tab",
              "aria-selected": props.active === item.id,
              "data-active": props.active === item.id ? "true" : "false",
              onClick: () => props.onChange(item.id),
            },
            item.label,
            item.count !== undefined ? h("span", { className: "mcpm-tab-count" }, ` ${item.count}`) : null,
          ),
        ),
      );
    }

    function Segmented(props) {
      return h(
        "div",
        { className: "mcpm-seg", role: "group", "aria-label": props.label },
        props.items.map((item) =>
          h(
            "button",
            {
              key: item.id,
              type: "button",
              "data-active": props.value === item.id ? "true" : "false",
              onClick: () => props.onChange(item.id),
            },
            item.label,
          ),
        ),
      );
    }

    /* ------------------------------------------------------------ server --- */

    function ProbeBlock(props) {
      const probe = props.probe;
      if (!probe) {
        return h("div", { className: "mcpm-probe" }, h("span", { className: "mcpm-meta" }, "No connection test yet. Run a test to verify the server answers the MCP handshake."));
      }
      if (!probe.ok) {
        return h(
          "div",
          { className: "mcpm-probe", "data-ok": "false" },
          h("div", { className: "mcpm-probe-title" }, h("span", { className: "mcpm-dot", "data-kind": "fail" }), " Connection failed"),
          h("div", { className: "mcpm-code" }, probe.error || "unknown error"),
          probe.hint ? h("div", { className: "mcpm-hint" }, probe.hint) : null,
          h("div", { className: "mcpm-meta" }, `Last attempt ${timeAgo(probe.at)}`),
        );
      }
      return h(
        "div",
        { className: "mcpm-probe" },
        h(
          "div",
          { className: "mcpm-probe-title" },
          h("span", { className: "mcpm-dot", "data-kind": "ok" }),
          ` ${probe.serverName || "server"} ${probe.serverVersion || ""}`.trim(),
        ),
        h(
          "div",
          { className: "mcpm-meta" },
          `${probe.toolCount ?? 0} tool(s) · protocol ${probe.protocolVersion || "?"} · ${probe.ms ?? "?"} ms · ${timeAgo(probe.at)}`,
        ),
        probe.instructions ? h("div", { className: "mcpm-hint" }, probe.instructions) : null,
        probe.tools?.length
          ? h(
              "div",
              { className: "mcpm-tools" },
              probe.tools.map((tool) =>
                h("span", { key: tool.name, className: "mcpm-tool", title: tool.description || "" }, tool.name),
              ),
            )
          : null,
      );
    }

    function exposeHint(server) {
      if (!server.expose) return "Off. This switch is global: while on, every chat sees this server's tools. A chat can opt out at any time with /mcp-<server>.";
      const runtime = server.runtime ?? {};
      if (runtime.state === "ready") {
        const names = (runtime.tools ?? []).map((tool) => tool.name);
        return `On for every chat — ${names.length} tool(s) live${names.length ? `: ${names.join(", ")}` : ""}. A chat can hide them with /mcp-<server>.`;
      }
      if (runtime.state === "error") return `Could not start the session: ${runtime.error}`;
      if (runtime.state === "connecting") return "Opening the MCP session…";
      return "Off.";
    }

    function ServerDetail(props) {
      const server = props.server;
      const rows = [];
      rows.push(["Transport", transportLabel(server.transport)]);
      rows.push(["Source", `${server.sourceLabel}${server.sourcePath && server.sourcePath !== "Managed here" ? ` · ${server.sourcePath}` : ""}`]);
      rows.push(["Scope", server.scope]);
      if (server.workspace) rows.push(["Workspace", server.workspace]);
      if (server.envKeys?.length) rows.push(["Environment", server.envKeys.join(", ")]);
      if (server.headerKeys?.length) rows.push(["Headers", server.headerKeys.join(", ")]);
      if (server.note) rows.push(["Note", server.note]);
      if (server.updatedAt) rows.push(["Updated", `${timeAgo(server.updatedAt)} (${new Date(server.updatedAt).toLocaleString()})`]);

      return h(
        "div",
        { className: "mcpm-detail" },
        h("div", { className: "mcpm-code" }, specLines(server) || "(no command or URL)"),
        h("dl", { className: "mcpm-kv" }, rows.map(([key, value]) => h(React.Fragment, { key }, h("dt", null, key), h("dd", null, value)))),
        h(ProbeBlock, { probe: server.probe }),
        server.managed
          ? h(
              "div",
              { className: "mcpm-expose" },
              h(
                "div",
                { className: "mcpm-expose-text" },
                h("strong", null, "Expose tools to every chat"),
                h("span", null, exposeHint(server)),
              ),
              h(
                Button,
                {
                  variant: server.expose ? "primary" : "ghost",
                  onClick: () => props.onExpose(server, !server.expose),
                  disabled: props.busy,
                },
                server.expose ? "Stop exposing" : "Expose tools",
              ),
            )
          : null,
        h(
          "div",
          { className: "mcpm-detail-actions" },
          h(Button, { onClick: () => props.onProbe(server), disabled: props.busy }, props.busy ? "Testing…" : "Test connection"),
          h(Button, { onClick: () => props.onCopy(server) }, "Copy JSON"),
          server.managed
            ? h(Button, { onClick: () => props.onEdit(server) }, "Edit")
            : h(Button, { onClick: () => props.onAdd(server), title: "Copy this definition into the MCP Manager pool" }, "Copy to pool"),
          server.managed
            ? h(Button, { variant: "danger", onClick: () => props.onDelete(server) }, "Move to trash")
            : h("span", { className: "mcpm-hint" }, "This entry belongs to another application and is read-only."),
        ),
      );
    }

    function ServerRow(props) {
      const server = props.server;
      const status = serverStatus(server);
      return h(
        "li",
        { className: "mcpm-row" },
        h(
          "div",
          {
            className: "mcpm-row-head",
            role: "button",
            tabIndex: 0,
            "aria-expanded": props.expanded,
            onClick: () => props.onToggle(server),
            onKeyDown: (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                props.onToggle(server);
              }
            },
          },
          h("span", { className: "mcpm-dot", "data-kind": status.kind, title: status.label }),
          h("span", { className: "mcpm-name" }, server.name),
          h("span", { className: "mcpm-chip", "data-managed": server.managed ? "true" : "false" }, server.managed ? "pool" : server.sourceApp || server.sourceLabel),
          h("span", { className: "mcpm-chip" }, transportLabel(server.transport)),
          server.expose
            ? h(
                "span",
                { className: "mcpm-chip mcpm-chip-exposed", title: exposeHint(server) },
                server.runtime?.state === "ready" ? `exposed · ${server.runtime.tools.length}` : `exposed · ${server.runtime?.state ?? "off"}`,
              )
            : null,
          h("span", { className: "mcpm-display" }, specLines(server)),
          h("span", { className: "mcpm-status" }, status.label),
          h(Button, {
            variant: "ghost",
            onClick: (event) => {
              event.stopPropagation();
              props.onProbe(server);
            },
            disabled: props.busy,
            title: `Test ${server.name}`,
          }, props.busy ? "…" : "Test"),
        ),
        props.expanded ? h(ServerDetail, props) : null,
      );
    }

    /* ------------------------------------------------------------ modals --- */

    function EditorModal(props) {
      const initial = props.initial ?? {};
      const [form, setForm] = useState({
        name: initial.name ?? "",
        transport: initial.transport ?? "stdio",
        command: initial.command ?? "",
        argsText: (initial.args ?? []).join("\n"),
        cwd: initial.cwd ?? "",
        envText: pairsText(initial.env),
        url: initial.url ?? "",
        headersText: pairsText(initial.headers),
        note: initial.note ?? "",
        enabled: initial.enabled !== false,
      });
      const [error, setError] = useState("");
      const update = (patch) => setForm((current) => ({ ...current, ...patch }));

      const submit = async () => {
        setError("");
        if (!form.name.trim()) {
          setError("A name is required.");
          return;
        }
        if (form.transport === "stdio" && !form.command.trim()) {
          setError("A stdio server needs a command.");
          return;
        }
        if (form.transport !== "stdio" && !form.url.trim()) {
          setError("A remote server needs a URL.");
          return;
        }
        try {
          await props.onSubmit({
            name: form.name.trim(),
            transport: form.transport,
            command: form.transport === "stdio" ? form.command.trim() : "",
            args: form.transport === "stdio" ? splitList(form.argsText) : [],
            cwd: form.transport === "stdio" ? form.cwd.trim() : "",
            env: form.transport === "stdio" ? parsePairs(form.envText) : {},
            url: form.transport === "stdio" ? "" : form.url.trim(),
            headers: form.transport === "stdio" ? {} : parsePairs(form.headersText),
            note: form.note.trim(),
            enabled: form.enabled,
          });
        } catch (submitError) {
          setError(submitError?.message ?? String(submitError));
        }
      };

      return h(
        Modal,
        {
          title: props.mode === "edit" ? `Edit ${initial.name}` : "New MCP server",
          onClose: props.onClose,
          footer: [
            h(Button, { key: "cancel", onClick: props.onClose }, "Cancel"),
            h(Button, { key: "save", variant: "primary", onClick: submit, disabled: props.busy }, props.busy ? "Saving…" : "Save"),
          ],
        },
        error ? h("div", { className: "mcpm-error-banner" }, error) : null,
        h(Field, { label: "Name" }, h("input", { className: "mcpm-input", value: form.name, onChange: (e) => update({ name: e.target.value }), placeholder: "github" })),
        h(
          Field,
          { label: "Transport" },
          h(
            "select",
            { className: "mcpm-select", value: form.transport, onChange: (e) => update({ transport: e.target.value }) },
            h("option", { value: "stdio" }, "stdio — local process"),
            h("option", { value: "http" }, "HTTP — streamable endpoint"),
            h("option", { value: "sse" }, "SSE — legacy event stream"),
          ),
        ),
        form.transport === "stdio"
          ? [
              h(Field, { key: "cmd", label: "Command" }, h("input", { className: "mcpm-input", value: form.command, onChange: (e) => update({ command: e.target.value }), placeholder: "npx" })),
              h(
                Field,
                { key: "args", label: "Arguments", hint: "One argument per line." },
                h("textarea", { className: "mcpm-area", rows: 3, value: form.argsText, onChange: (e) => update({ argsText: e.target.value }), placeholder: "-y\n@modelcontextprotocol/server-filesystem\nC:\\work" }),
              ),
              h(
                Field,
                { key: "env", label: "Environment", hint: "KEY=value per line. Stored locally in the plugin state file." },
                h("textarea", { className: "mcpm-area", rows: 3, value: form.envText, onChange: (e) => update({ envText: e.target.value }) }),
              ),
              h(Field, { key: "cwd", label: "Working directory" }, h("input", { className: "mcpm-input", value: form.cwd, onChange: (e) => update({ cwd: e.target.value }), placeholder: "optional" })),
            ]
          : [
              h(Field, { key: "url", label: "URL" }, h("input", { className: "mcpm-input", value: form.url, onChange: (e) => update({ url: e.target.value }), placeholder: "https://mcp.example.com/mcp" })),
              h(
                Field,
                { key: "headers", label: "Headers", hint: "Name: value per line, for example Authorization: Bearer …" },
                h("textarea", { className: "mcpm-area", rows: 3, value: form.headersText, onChange: (e) => update({ headersText: e.target.value }) }),
              ),
            ],
        h(Field, { label: "Note" }, h("input", { className: "mcpm-input", value: form.note, onChange: (e) => update({ note: e.target.value }), placeholder: "optional" })),
        h(
          "label",
          { className: "mcpm-check" },
          h("input", { type: "checkbox", checked: form.enabled, onChange: (e) => update({ enabled: e.target.checked }) }),
          " Enabled",
        ),
      );
    }

    function ImportModal(props) {
      const [text, setText] = useState("");
      const [error, setError] = useState("");
      const submit = async () => {
        setError("");
        if (!text.trim()) {
          setError("Paste a JSON document first.");
          return;
        }
        try {
          await props.onSubmit(text);
        } catch (submitError) {
          setError(submitError?.message ?? String(submitError));
        }
      };
      return h(
        Modal,
        {
          title: "Import servers",
          onClose: props.onClose,
          footer: [
            h(Button, { key: "cancel", onClick: props.onClose }, "Cancel"),
            h(Button, { key: "import", variant: "primary", onClick: submit, disabled: props.busy }, props.busy ? "Importing…" : "Import"),
          ],
        },
        error ? h("div", { className: "mcpm-error-banner" }, error) : null,
        h("div", { className: "mcpm-hint" }, "Paste a claude_desktop_config.json, a VS Code mcp.json, a Cursor mcp.json or a bare name → server object. Servers already in the pool are skipped."),
        h("textarea", {
          className: "mcpm-area mcpm-area-code",
          rows: 12,
          value: text,
          onChange: (event) => setText(event.target.value),
          placeholder: '{\n  "mcpServers": {\n    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }\n  }\n}',
        }),
      );
    }

    function ExportModal(props) {
      const [format, setFormat] = useState("json");
      const [text, setText] = useState("");
      const [error, setError] = useState("");
      const [copied, setCopied] = useState(false);

      useEffect(() => {
        let alive = true;
        setText("");
        setError("");
        props
          .load(format)
          .then((value) => {
            if (alive) setText(value);
          })
          .catch((loadError) => {
            if (alive) setError(loadError?.message ?? String(loadError));
          });
        return () => {
          alive = false;
        };
      }, [format]);

      const labels = {
        json: "mcpServers JSON (Claude, Cursor, VS Code, Windsurf…)",
        vscode: "VS Code servers JSON",
        codex: "Codex config.toml",
      };

      return h(
        Modal,
        {
          title: "Export pool",
          onClose: props.onClose,
          footer: [
            h(Button, {
              key: "copy",
              variant: "primary",
              disabled: !text,
              onClick: async () => {
                const ok = await copyText(text);
                setCopied(ok);
                setTimeout(() => setCopied(false), 1500);
              },
            }, copied ? "Copied" : "Copy"),
            h(Button, { key: "close", onClick: props.onClose }, "Close"),
          ],
        },
        error ? h("div", { className: "mcpm-error-banner" }, error) : null,
        h(
          Field,
          { label: "Format" },
          h(
            "select",
            { className: "mcpm-select", value: format, onChange: (event) => setFormat(event.target.value) },
            Object.entries(labels).map(([value, label]) => h("option", { key: value, value }, label)),
          ),
        ),
        h("textarea", { className: "mcpm-area mcpm-area-code", rows: 14, readOnly: true, value: text }),
      );
    }

    /* --------------------------------------------------------------- page --- */

    function McpManagerSection() {
      const [snapshot, setSnapshot] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState("");
      const [tab, setTab] = useState("servers");
      const [query, setQuery] = useState("");
      const [scope, setScope] = useState("all");
      const [workspace, setWorkspace] = useState("");
      const [expanded, setExpanded] = useState("");
      const [busyKey, setBusyKey] = useState("");
      const [busy, setBusy] = useState(false);
      const [editor, setEditor] = useState(null);
      const [importer, setImporter] = useState(false);
      const [exporter, setExporter] = useState(false);
      const [toast, setToast] = useState(null);
      const mounted = useRef(true);

      useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
        };
      }, []);

      const notify = useCallback((text, kind = "info") => {
        setToast({ text, kind, at: Date.now() });
      }, []);

      useEffect(() => {
        if (!toast) return undefined;
        const timer = setTimeout(() => setToast(null), toast.kind === "error" ? 6000 : 2600);
        return () => clearTimeout(timer);
      }, [toast]);

      const load = useCallback(async () => {
        setLoading(true);
        try {
          const data = await apiGet(`/state${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`);
          if (!mounted.current) return;
          setSnapshot(data.snapshot);
          setError("");
        } catch (loadError) {
          if (!mounted.current) return;
          setError(loadError?.message ?? String(loadError));
        } finally {
          if (mounted.current) setLoading(false);
        }
      }, [workspace]);

      useEffect(() => {
        load();
      }, [load]);

      const act = useCallback(async (payload) => {
        const data = await apiPost(payload);
        if (mounted.current && data?.snapshot) setSnapshot(data.snapshot);
        return data;
      }, []);

      const run = useCallback(
        async (label, fn) => {
          setBusy(true);
          try {
            await fn();
            if (label) notify(label);
          } catch (runError) {
            notify(runError?.message ?? String(runError), "error");
          } finally {
            if (mounted.current) {
              setBusy(false);
              setBusyKey("");
            }
          }
        },
        [notify],
      );

      const probe = useCallback(
        async (server) => {
          setBusyKey(server.key);
          try {
            const data = await act({ action: "probe", keys: [server.key] });
            const result = data?.results?.[0];
            if (result?.ok) notify(`${server.name}: ${result.toolCount ?? 0} tool(s) reachable`);
            else notify(`${server.name}: ${result?.error ?? "connection failed"}`, "error");
          } catch (probeError) {
            notify(probeError?.message ?? String(probeError), "error");
          } finally {
            if (mounted.current) setBusyKey("");
          }
        },
        [act, notify],
      );

      const copyServer = useCallback(
        async (server) => {
          try {
            const data = await act({ action: "spec", key: server.key });
            const ok = await copyText(snippetFor(data.server));
            notify(ok ? "Server snippet copied" : "Could not access the clipboard", ok ? "info" : "error");
          } catch (copyError) {
            notify(copyError?.message ?? String(copyError), "error");
          }
        },
        [act, notify],
      );

      const openEdit = useCallback(async (server) => {
        try {
          const data = await act({ action: "spec", key: server.key });
          setEditor({ mode: "edit", server: data.server });
        } catch (editError) {
          notify(editError?.message ?? String(editError), "error");
        }
      }, [act, notify]);

      const openAdd = useCallback((server) => {
        setEditor({
          mode: "new",
          server: {
            name: server.name,
            transport: server.transport,
            command: server.command,
            args: server.args,
            cwd: server.cwd,
            url: server.url,
            enabled: server.enabled,
          },
        });
      }, []);

      const saveServer = useCallback(
        async (payload) => {
          setBusy(true);
          try {
            await act({ action: "save", ...(editor?.server?.id ? { id: editor.server.id } : {}), ...payload });
            notify(editor?.mode === "edit" ? "Saved" : "Server created");
            setEditor(null);
          } finally {
            if (mounted.current) setBusy(false);
          }
        },
        [act, editor, notify],
      );

      const removeServer = useCallback(
        async (server) => {
          if (!window.confirm(`Move "${server.name}" to the trash?`)) return;
          await run("Moved to trash", () => act({ action: "delete", key: server.key }));
        },
        [act, run],
      );

      const exposeServer = useCallback(
        async (server, exposed) => {
          await run(null, async () => {
            const data = await act({ action: "set-expose", key: server.key, exposed });
            const target = data?.snapshot?.servers?.find((item) => item.key === server.key);
            const runtime = target?.runtime;
            if (!exposed) {
              notify(`${server.name} is no longer exposed`);
              return;
            }
            if (runtime?.state === "ready") {
              notify(`${server.name}: ${runtime.tools.length} tool(s) callable by the agent`);
            } else if (runtime?.state === "error") {
              notify(`${server.name}: ${runtime.error}`, "error");
            } else {
              notify(`${server.name}: opening MCP session…`);
            }
          });
        },
        [act, notify, run],
      );

      const probeVisible = useCallback(
        async (servers) => {
          const keys = servers.map((server) => server.key).slice(0, 40);
          if (!keys.length) return;
          await run(`Tested ${keys.length} server(s)`, () => act({ action: "probe", keys }));
        },
        [act, run],
      );

      if (loading && !snapshot) {
        return h("div", { className: "mcpm" }, h("div", { className: "mcpm-empty" }, "Loading MCP servers…"));
      }
      if (error && !snapshot) {
        return h(
          "div",
          { className: "mcpm" },
          h("div", { className: "mcpm-error-banner" }, error),
          h(Button, { onClick: load }, "Retry"),
        );
      }
      if (!snapshot) return null;

      const { servers, stats, trash, sources, workspaces } = snapshot;
      const normalizedQuery = query.trim().toLowerCase();
      const filtered = servers.filter((server) => {
        if (scope === "managed" && !server.managed) return false;
        if (scope === "discovered" && server.managed) return false;
        if (!normalizedQuery) return true;
        return [server.name, server.sourceLabel, server.sourceApp, server.display, ...(server.tags ?? [])]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(normalizedQuery));
      });

      const tabs = [
        { id: "servers", label: "Servers", count: servers.length },
        { id: "sources", label: "Sources", count: sources.filter((source) => source.exists).length },
        { id: "trash", label: "Trash", count: trash.length },
      ];

      return h(
        "div",
        { className: "mcpm" },
        h("style", { key: "css" }, CSS),
        h(
          "header",
          { className: "mcpm-head" },
          h(
            "div",
            { className: "mcpm-heading" },
            h("h2", { className: "mcpm-title" }, DICT.en.title),
            h("p", { className: "mcpm-sub" }, DICT.en.subtitle),
          ),
          h(
            "div",
            { className: "mcpm-actions" },
            h(Button, { onClick: load, disabled: loading }, loading ? "Refreshing…" : "Refresh"),
            h(Button, { onClick: () => setImporter(true) }, "Import"),
            h(Button, { onClick: () => setExporter(true) }, "Export"),
            h(Button, { variant: "primary", onClick: () => setEditor({ mode: "new", server: {} }) }, "New server"),
          ),
        ),
        snapshot.corruptState
          ? h("div", { className: "mcpm-error-banner" }, `The plugin state file is unreadable: ${snapshot.corruptState}. Fix or delete ${snapshot.statePath}.`)
          : null,
        error ? h("div", { className: "mcpm-error-banner" }, error) : null,
        h(
          "div",
          { className: "mcpm-stats" },
          [
            ["Servers", stats.total, ""],
            ["Healthy", stats.healthy, "ok"],
            ["Failing", stats.failing, "fail"],
            ["Untested", stats.untested, "warn"],
          ].map(([label, value, tone]) =>
            h("div", { key: label, className: "mcpm-stat", "data-tone": tone }, h("b", null, value), h("span", null, label)),
          ),
        ),
        h(Tabs, { items: tabs, active: tab, onChange: setTab }),
        tab === "servers"
          ? h(
              "div",
              { className: "mcpm-panel" },
              h(
                "div",
                { className: "mcpm-toolbar" },
                h("input", {
                  className: "mcpm-input mcpm-search",
                  value: query,
                  onChange: (event) => setQuery(event.target.value),
                  placeholder: "Search servers…",
                  "aria-label": "Search servers",
                }),
                h(Segmented, {
                  label: "Scope filter",
                  value: scope,
                  onChange: setScope,
                  items: [
                    { id: "all", label: "All" },
                    { id: "managed", label: "Pool" },
                    { id: "discovered", label: "Discovered" },
                  ],
                }),
                workspaces.length
                  ? h(
                      "select",
                      { className: "mcpm-select", value: workspace, onChange: (event) => setWorkspace(event.target.value), "aria-label": "Workspace" },
                      h("option", { value: "" }, "All workspaces"),
                      workspaces.map((item) => h("option", { key: item.id, value: item.fullPath }, item.title || item.path)),
                    )
                  : null,
                h(Button, { onClick: () => probeVisible(filtered), disabled: busy || !filtered.length }, "Test visible"),
              ),
              filtered.length
                ? h(
                    "ul",
                    { className: "mcpm-list" },
                    filtered.map((server) =>
                      h(ServerRow, {
                        key: server.key,
                        server,
                        expanded: expanded === server.key,
                        onToggle: (target) => setExpanded((current) => (current === target.key ? "" : target.key)),
                        onProbe: probe,
                        onCopy: copyServer,
                        onEdit: openEdit,
                        onAdd: openAdd,
                        onDelete: removeServer,
                        onExpose: exposeServer,
                        busy: busyKey === server.key || busy,
                      }),
                    ),
                  )
                : h("div", { className: "mcpm-empty" }, normalizedQuery || scope !== "all" ? "No server matches this filter." : "No MCP servers found on this machine yet. Create one, import one, or install MCP servers in your favourite client."),
              h(
                "div",
                { className: "mcpm-footnote" },
                `Scan finished ${timeAgo(snapshot.scannedAt)} · pool state ${snapshot.statePath}. Discovered entries are read-only: MCP Manager never rewrites other applications' config files.`,
              ),
            )
          : null,
        tab === "sources" ? h(SourcesTab, { sources, workspaces, statePath: snapshot.statePath }) : null,
        tab === "trash"
          ? h(TrashTab, {
              trash,
              busy,
              onRestore: (entry) => run("Restored", () => act({ action: "restore", id: entry.id })),
              onPurge: (entry) => run("Deleted", () => act({ action: "purge", id: entry.id })),
              onEmpty: () => run("Trash emptied", () => act({ action: "empty-trash" })),
            })
          : null,
        editor
          ? h(EditorModal, {
              mode: editor.mode,
              initial: editor.server,
              busy,
              onClose: () => setEditor(null),
              onSubmit: saveServer,
            })
          : null,
        importer
          ? h(ImportModal, {
              busy,
              onClose: () => setImporter(false),
              onSubmit: async (text) => {
                const data = await act({ action: "import", text });
                notify(`Imported ${data.added ?? 0} of ${data.total ?? 0} server(s)`);
                setImporter(false);
              },
            })
          : null,
        exporter
          ? h(ExportModal, {
              onClose: () => setExporter(false),
              load: async (format) => (await act({ action: "export", format })).text,
            })
          : null,
        toast ? h("div", { className: "mcpm-toast", "data-kind": toast.kind, role: "status" }, toast.text) : null,
      );
    }

    function SourcesTab(props) {
      const { sources, workspaces, statePath } = props;
      const rows = [...sources].sort((a, b) => {
        if (a.exists !== b.exists) return a.exists ? -1 : 1;
        return String(a.app ?? "").localeCompare(String(b.app ?? ""));
      });
      return h(
        "div",
        { className: "mcpm-panel" },
        h(
          "ul",
          { className: "mcpm-list" },
          rows.map((source) =>
            h(
              "li",
              { key: source.id, className: "mcpm-row" },
              h(
                "div",
                { className: "mcpm-row-head mcpm-row-static" },
                h("span", { className: "mcpm-dot", "data-kind": source.error ? "fail" : source.exists ? "ok" : "disabled" }),
                h("span", { className: "mcpm-name" }, source.app),
                h("span", { className: "mcpm-chip" }, source.scope),
                h("span", { className: "mcpm-display", title: source.path }, source.path),
                h("span", { className: "mcpm-status" }, source.error ? "error" : source.exists ? `${source.count} server(s)` : "not found"),
              ),
              source.error
                ? h("div", { className: "mcpm-detail" }, h("div", { className: "mcpm-code" }, source.error))
                : source.exists
                  ? h(
                      "div",
                      { className: "mcpm-detail" },
                      h(
                        "dl",
                        { className: "mcpm-kv" },
                        h("dt", null, "Format"),
                        h("dd", null, source.format),
                        h("dt", null, "Size"),
                        h("dd", null, formatBytes(source.size)),
                        h("dt", null, "Modified"),
                        h("dd", null, source.updatedAt ? `${timeAgo(source.updatedAt)} (${new Date(source.updatedAt).toLocaleString()})` : "unknown"),
                      ),
                    )
                  : null,
            ),
          ),
        ),
        h(
          "div",
          { className: "mcpm-footnote" },
          workspaces?.length ? `Project configs are scanned for ${workspaces.length} workspace(s).` : "No workspaces registered, so only user-level configs were scanned.",
          " ",
          `Plugin state lives in ${statePath}.`,
        ),
      );
    }

    function TrashTab(props) {
      const { trash } = props;
      if (!trash.length) {
        return h("div", { className: "mcpm-empty" }, "The trash is empty. Deleted pool servers wait here so you can restore them.");
      }
      return h(
        "div",
        { className: "mcpm-panel" },
        h(
          "div",
          { className: "mcpm-toolbar" },
          h("span", { className: "mcpm-meta" }, `${trash.length} deleted server(s)`),
          h(Button, { variant: "danger", onClick: props.onEmpty, disabled: props.busy }, "Empty trash"),
        ),
        h(
          "ul",
          { className: "mcpm-list" },
          trash.map((entry) =>
            h(
              "li",
              { key: entry.id, className: "mcpm-row" },
              h(
                "div",
                { className: "mcpm-row-head mcpm-row-static" },
                h("span", { className: "mcpm-dot", "data-kind": "disabled" }),
                h("span", { className: "mcpm-name" }, entry.name),
                h("span", { className: "mcpm-chip" }, transportLabel(entry.transport)),
                h("span", { className: "mcpm-display" }, entry.display),
                h("span", { className: "mcpm-status" }, timeAgo(entry.deletedAt)),
                h(Button, { onClick: () => props.onRestore(entry), disabled: props.busy }, "Restore"),
                h(Button, { variant: "danger", onClick: () => props.onPurge(entry), disabled: props.busy }, "Delete"),
              ),
            ),
          ),
        ),
      );
    }

    /* --------------------------------------------------------- sidebar --- */

    /* The sidebar entry is an icon-only button: the harness passes the square
     * edge it wants and whether this panel is selected. Drawing with
     * currentColor keeps the glyph on the sidebar's own palette. */
    const PANEL_ICON_SVG =
      '<g fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="2.3" y="2.7" width="11.4" height="4.5" rx="1.3"/>' +
      '<rect x="2.3" y="8.8" width="11.4" height="4.5" rx="1.3"/>' +
      '<path d="M4.5 4.95h.01M4.5 11.05h.01"/>' +
      "</g>";

    function McpPanelIcon(props) {
      const size = typeof props?.size === "number" && props.size > 0 ? props.size : 16;
      return h("svg", {
        viewBox: "0 0 16 16",
        width: size,
        height: size,
        fill: "currentColor",
        "aria-hidden": "true",
        focusable: "false",
        dangerouslySetInnerHTML: { __html: PANEL_ICON_SVG },
      });
    }

    /* Same page, mounted in the central column instead of a settings section:
     * the wrapper supplies the scrolling surface and the readable column. */
    function McpPanel() {
      return h("div", { className: "mcpm-page" }, h(McpManagerSection, {}));
    }

    /* --------------------------------------------------------------- css --- */

    const CSS = `
.mcpm { display:flex; flex-direction:column; gap:16px; color: var(--dsw-alias-label-primary); font-size:13px; }
.mcpm *, .mcpm *::before, .mcpm *::after { box-sizing: border-box; }
.mcpm-page { box-sizing:border-box; height:100%; min-height:0; overflow-y:auto; display:flex; flex-direction:column; align-items:center; padding:28px clamp(24px,4vw,48px) 48px; }
.mcpm-page > .mcpm { width:100%; max-width:980px; }
.mcpm-head { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; flex-wrap:wrap; }
.mcpm-title { margin:0; font-size:18px; font-weight:600; letter-spacing:-0.01em; color: var(--dsw-alias-label-primary); }
.mcpm-sub { margin:5px 0 0; color: var(--dsw-alias-label-secondary); font-size:12.5px; line-height:1.5; max-width:66ch; }
.mcpm-actions { display:flex; gap:8px; flex-wrap:wrap; }
.mcpm-btn { appearance:none; font:inherit; font-size:12.5px; line-height:1; padding:8px 12px; border-radius:8px; border:1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor:pointer; white-space:nowrap; transition: background .12s ease, border-color .12s ease, opacity .12s ease; }
.mcpm-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.mcpm-btn:disabled { opacity:.5; cursor:not-allowed; }
.mcpm-btn.primary { background: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-base); font-weight:600; }
.mcpm-btn.primary:hover:not(:disabled) { background: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-primary); opacity:.88; }
.mcpm-btn.ghost { background: transparent; border-color: transparent; padding:6px 8px; }
.mcpm-btn.danger { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-border-l2); }
.mcpm-stats { display:grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap:8px; }
.mcpm-stat { border:1px solid var(--dsw-alias-border-l1); border-radius:10px; padding:10px 12px; background: var(--dsw-alias-bg-layer-1); }
.mcpm-stat b { display:block; font-size:19px; font-weight:600; line-height:1.2; }
.mcpm-stat span { color: var(--dsw-alias-label-secondary); font-size:10.5px; text-transform:uppercase; letter-spacing:.07em; }
.mcpm-stat[data-tone="ok"] b { color: var(--dsw-alias-state-success-primary); }
.mcpm-stat[data-tone="fail"] b { color: var(--dsw-alias-state-error-primary); }
.mcpm-stat[data-tone="warn"] b { color: var(--dsw-alias-state-warn-primary); }
.mcpm-tabs { display:flex; gap:2px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.mcpm-tab { appearance:none; border:none; background:none; font:inherit; font-size:12.5px; padding:8px 12px; color: var(--dsw-alias-label-secondary); border-bottom:2px solid transparent; margin-bottom:-1px; cursor:pointer; }
.mcpm-tab:hover { color: var(--dsw-alias-label-primary); }
.mcpm-tab[data-active="true"] { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-label-primary); }
.mcpm-tab-count { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.mcpm-panel { display:flex; flex-direction:column; gap:10px; }
.mcpm-toolbar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.mcpm-search { flex:1 1 220px; min-width:160px; }
.mcpm-input, .mcpm-select, .mcpm-area { font:inherit; font-size:12.5px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:7px 9px; }
.mcpm-input:focus, .mcpm-select:focus, .mcpm-area:focus { outline:none; border-color: var(--dsw-alias-label-secondary); }
.mcpm-area { resize:vertical; line-height:1.45; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; }
.mcpm-area-code { width:100%; }
.mcpm-seg { display:inline-flex; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; overflow:hidden; }
.mcpm-seg button { appearance:none; border:none; background:transparent; font:inherit; font-size:12px; padding:7px 10px; color: var(--dsw-alias-label-secondary); cursor:pointer; }
.mcpm-seg button[data-active="true"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.mcpm-list { list-style:none; margin:0; padding:0; border:1px solid var(--dsw-alias-border-l1); border-radius:12px; overflow:hidden; background: var(--dsw-alias-bg-layer-1); }
.mcpm-row + .mcpm-row { border-top:1px solid var(--dsw-alias-border-l1); }
.mcpm-row-head { display:flex; gap:9px; align-items:center; padding:9px 12px; cursor:pointer; }
.mcpm-row-head:hover { background: var(--dsw-alias-bg-layer-2); }
.mcpm-row-static { cursor:default; }
.mcpm-row-static:hover { background: transparent; }
.mcpm-dot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; background: var(--dsw-alias-state-idle-primary); }
.mcpm-dot[data-kind="ok"] { background: var(--dsw-alias-state-success-primary); }
.mcpm-dot[data-kind="fail"] { background: var(--dsw-alias-state-error-primary); }
.mcpm-dot[data-kind="untested"] { background: var(--dsw-alias-state-warn-primary); }
.mcpm-dot[data-kind="disabled"] { background: var(--dsw-alias-state-idle-primary); }
.mcpm-name { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:220px; }
.mcpm-chip { font-size:10.5px; padding:2px 7px; border-radius:999px; border:1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); white-space:nowrap; flex:0 0 auto; }
.mcpm-chip[data-managed="true"] { color: var(--dsw-alias-label-primary); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, var(--dsw-alias-border-l1)); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, var(--dsw-alias-bg-layer-1)); }
.mcpm-display { flex:1 1 auto; min-width:0; color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:11.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.mcpm-status { color: var(--dsw-alias-label-secondary); font-size:11.5px; white-space:nowrap; flex:0 0 auto; }
.mcpm-detail { padding: 2px 12px 14px 29px; display:flex; flex-direction:column; gap:9px; }
.mcpm-detail-actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.mcpm-expose { display:flex; gap:12px; align-items:center; justify-content:space-between; flex-wrap:wrap; padding:10px 12px; border:1px solid var(--dsw-alias-border-l2); border-radius:10px; background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 55%, var(--dsw-alias-bg-base)); }
.mcpm-expose-text { display:flex; flex-direction:column; gap:3px; min-width:0; flex:1 1 260px; }
.mcpm-expose-text strong { font-size:12.5px; font-weight:600; color: var(--dsw-alias-label-primary); }
.mcpm-expose-text span { font-size:11.5px; line-height:1.5; color: var(--dsw-alias-label-secondary); word-break:break-word; }
.mcpm-chip-exposed { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, var(--dsw-alias-border-l1)); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, var(--dsw-alias-bg-layer-1)); }
.mcpm-kv { display:grid; grid-template-columns: 128px minmax(0,1fr); gap:5px 12px; margin:0; font-size:12px; }
.mcpm-kv dt { color: var(--dsw-alias-label-secondary); }
.mcpm-kv dd { margin:0; word-break: break-word; }
.mcpm-code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:11.5px; line-height:1.5; background: var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:8px 10px; overflow:auto; max-height:200px; white-space:pre-wrap; word-break:break-word; }
.mcpm-probe { border:1px solid var(--dsw-alias-border-l1); border-radius:10px; padding:9px 11px; background: var(--dsw-alias-bg-base); display:flex; flex-direction:column; gap:6px; }
.mcpm-probe[data-ok="false"] { border-color: var(--dsw-alias-state-error-primary); }
.mcpm-probe-title { font-weight:600; font-size:12.5px; display:flex; align-items:center; gap:7px; }
.mcpm-tools { display:flex; flex-wrap:wrap; gap:6px; }
.mcpm-tool { font-size:11px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; padding:1px 6px; color: var(--dsw-alias-label-secondary); }
.mcpm-meta { color: var(--dsw-alias-label-secondary); font-size:11.5px; }
.mcpm-hint { color: var(--dsw-alias-label-secondary); font-size:11.5px; line-height:1.45; }
.mcpm-footnote { color: var(--dsw-alias-label-secondary); font-size:11px; line-height:1.5; }
.mcpm-empty { padding:34px 16px; text-align:center; color: var(--dsw-alias-label-secondary); font-size:12.5px; line-height:1.6; border:1px dashed var(--dsw-alias-border-l1); border-radius:12px; }
.mcpm-error-banner { border:1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); padding:8px 10px; border-radius:8px; font-size:12px; line-height:1.45; }
.mcpm-check { display:flex; align-items:center; gap:8px; font-size:12.5px; }
.mcpm-modal-backdrop { position:fixed; inset:0; z-index:70; display:flex; align-items:flex-start; justify-content:center; padding:44px 16px; overflow:auto; background: rgba(8,10,18,.55); }
.mcpm-modal { width:min(650px,100%); background-color: var(--dsw-alias-bg-base); background-image: linear-gradient(var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1)), var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))); border:1px solid var(--dsw-alias-border-l2); border-radius:14px; box-shadow: 0 24px 60px rgba(0,0,0,.45); display:flex; flex-direction:column; }
.mcpm-modal-head { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:13px 16px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.mcpm-modal-body { padding:16px; display:flex; flex-direction:column; gap:12px; max-height: min(66vh, 640px); overflow:auto; }
.mcpm-modal-foot { display:flex; justify-content:flex-end; gap:8px; padding:12px 16px; border-top:1px solid var(--dsw-alias-border-l1); }
.mcpm-field { display:flex; flex-direction:column; gap:5px; }
.mcpm-field > label { font-size:11.5px; color: var(--dsw-alias-label-secondary); }
.mcpm-toast { position:fixed; left:50%; bottom:26px; transform:translateX(-50%); z-index:80; max-width:min(560px,90vw); padding:9px 14px; border-radius:10px; font-size:12.5px; background-color: var(--dsw-alias-bg-base); background-image: linear-gradient(var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1)), var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))); border:1px solid var(--dsw-alias-border-l2); box-shadow: 0 12px 32px rgba(0,0,0,.45); }
.mcpm-toast[data-kind="error"] { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
@media (max-width: 700px) {
  .mcpm-stats { grid-template-columns: 1fr 1fr; }
  .mcpm-kv { grid-template-columns: 96px minmax(0,1fr); }
  .mcpm-name { max-width:120px; }
  .mcpm-detail { padding-left:12px; }
}
`;

    /* ------------------------------------------------------------- apply --- */

    return {
      inject: ["slots"],
      apply(ctx) {
        try {
          const dispose = ctx.effect(() => ctx.locale.register(NS, DICT), "mcp-manager: locale");
          void dispose;
        } catch (error) {
          try {
            console.warn("[mcp-manager] locale registration failed", error);
          } catch {}
        }

        const title = () => {
          try {
            const value = ctx.locale.bind(NS)("title");
            return value && value !== "title" ? value : "MCP Manager";
          } catch {
            return "MCP Manager";
          }
        };

        const warn = (message, error) => {
          try {
            console.error(`[mcp-manager] ${message}`, error);
          } catch {}
        };

        /* A settings page, a sidebar icon and the panel it opens are three
         * separate registrations: the harness keeps them alive independently,
         * so one unavailable slot never hides the other two. */
        try {
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register({ name: "settings.section", id: "mcp-manager", order: 26, label: title, locale: NS }, McpManagerSection),
          );
        } catch (error) {
          warn("could not register the settings section", error);
        }

        /* The panel is registered as soon as the sidebar slot resolves, the same
         * order the shipped skills manager uses: the entry and its panel appear
         * together, and neither exists when the sidebar has no seat for it. */
        let panelRegistered = false;
        try {
          ctx.slots.inject("sidebar.panellist", () => {
            const entry = ctx.slots.register(
              { name: "sidebar.panellist", id: "mcp-manager", order: 3, label: title, locale: NS },
              McpPanelIcon,
            );
            if (!panelRegistered) {
              panelRegistered = true;
              try {
                ctx.slots.register({ name: "main", key: "mcp-manager", locale: NS }, McpPanel);
              } catch (error) {
                warn("could not register the main panel", error);
              }
            }
            return entry;
          });
        } catch (error) {
          warn("could not register the sidebar entry", error);
        }
      },
    };
  },
});
