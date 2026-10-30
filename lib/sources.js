import path from "node:path";
import { homedir } from "node:os";

/** Platform facts resolved once; every path is computed at scan time so a changed
 *  environment (HOME, APPDATA, DSH_HOME) is picked up without a process restart. */
export const PLATFORM = process.platform;
const WIN = PLATFORM === "win32";
const MAC = PLATFORM === "darwin";

function env(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function homeDir() {
  return env("HOME") || env("USERPROFILE") || homedir();
}

export function appDataDir() {
  return env("APPDATA") || path.join(homeDir(), "AppData", "Roaming");
}

export function localAppDataDir() {
  return env("LOCALAPPDATA") || path.join(homeDir(), "AppData", "Local");
}

export function dshHomeDir() {
  return env("DSH_HOME") || path.join(homeDir(), ".dsh");
}

/** `<DSH_<AGENT>_HOME>` override, else a conventional dot-directory in the user home. */
function agentHome(envName, ...segments) {
  const override = env(envName);
  return override || path.join(homeDir(), ...segments);
}

function claudeDesktopConfig() {
  if (WIN) return path.join(appDataDir(), "Claude", "claude_desktop_config.json");
  if (MAC) return path.join(homeDir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return path.join(homeDir(), ".config", "Claude", "claude_desktop_config.json");
}

function vscodeUserDirs() {
  if (WIN) {
    return [
      path.join(appDataDir(), "Code", "User"),
      path.join(appDataDir(), "Code - Insiders", "User"),
    ];
  }
  if (MAC) {
    return [
      path.join(homeDir(), "Library", "Application Support", "Code", "User"),
      path.join(homeDir(), "Library", "Application Support", "Code - Insiders", "User"),
    ];
  }
  return [
    path.join(homeDir(), ".config", "Code", "User"),
    path.join(homeDir(), ".config", "Code - Insiders", "User"),
  ];
}

function zedSettingsPath() {
  if (WIN) return path.join(appDataDir(), "Zed", "settings.json");
  return path.join(homeDir(), ".config", "zed", "settings.json");
}

function extensionStorage(extensionId) {
  return vscodeUserDirs().map((dir) => path.join(dir, "globalStorage", extensionId));
}

/** User-level MCP definitions, in the order the dashboard lists them.
 *  `format` selects the parser + normalizer; `kind` separates user / harness / project scopes. */
export function userSources() {
  const sources = [
    {
      id: "dsh-connector",
      label: "DeepSeek Harness",
      app: "MCP Connector",
      format: "connector",
      file: path.join(dshHomeDir(), "storages", "mcp_connector.json"),
      note: "Connections registered through the Harness MCP Connector plugin.",
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      app: "Claude",
      format: "standard",
      file: claudeDesktopConfig(),
    },
    {
      id: "claude-code",
      label: "Claude Code",
      app: "Claude Code",
      format: "standard",
      file: path.join(homeDir(), ".claude.json"),
    },
    {
      id: "cursor",
      label: "Cursor",
      app: "Cursor",
      format: "standard",
      file: path.join(agentHome("DSH_CURSOR_HOME", ".cursor"), "mcp.json"),
    },
    {
      id: "windsurf",
      label: "Windsurf",
      app: "Windsurf",
      format: "standard",
      file: path.join(homeDir(), ".codeium", "windsurf", "mcp_config.json"),
    },
    {
      id: "codex",
      label: "Codex CLI",
      app: "Codex",
      format: "codex",
      file: path.join(agentHome("DSH_CODEX_HOME", ".codex"), "config.toml"),
    },
    {
      id: "zed",
      label: "Zed",
      app: "Zed",
      format: "zed",
      file: zedSettingsPath(),
    },
    {
      id: "gemini",
      label: "Gemini CLI",
      app: "Gemini",
      format: "standard",
      file: path.join(agentHome("DSH_GEMINI_HOME", ".gemini"), "settings.json"),
    },
    {
      id: "qwen",
      label: "Qwen Code",
      app: "Qwen Code",
      format: "standard",
      file: path.join(agentHome("DSH_QWEN_HOME", ".qwen"), "settings.json"),
    },
    {
      id: "opencode",
      label: "OpenCode",
      app: "OpenCode",
      format: "opencode",
      file: path.join(homeDir(), ".config", "opencode", "opencode.json"),
    },
    {
      id: "opencode-legacy",
      label: "OpenCode (legacy)",
      app: "OpenCode",
      format: "opencode",
      file: path.join(homeDir(), ".opencode.json"),
    },
    {
      id: "copilot-cli",
      label: "Copilot CLI",
      app: "Copilot",
      format: "standard",
      file: path.join(agentHome("DSH_COPILOT_HOME", ".copilot"), "mcp-config.json"),
    },
    {
      id: "amazon-q",
      label: "Amazon Q Developer",
      app: "Amazon Q",
      format: "standard",
      file: path.join(homeDir(), ".aws", "amazonq", "mcp.json"),
    },
    {
      id: "lm-studio",
      label: "LM Studio",
      app: "LM Studio",
      format: "standard",
      file: path.join(homeDir(), ".lmstudio", "mcp.json"),
    },
    {
      id: "droid",
      label: "Factory Droid",
      app: "Droid",
      format: "standard",
      file: path.join(homeDir(), ".factory", "mcp.json"),
    },
    {
      id: "qoder",
      label: "Qoder",
      app: "Qoder",
      format: "standard",
      file: path.join(agentHome("DSH_QODER_HOME", ".qoder"), "mcp.json"),
    },
    {
      id: "trae",
      label: "Trae",
      app: "Trae",
      format: "standard",
      file: path.join(agentHome("DSH_TRAE_HOME", ".trae"), "mcp.json"),
    },
    {
      id: "amp",
      label: "Amp",
      app: "Amp",
      format: "standard",
      file: path.join(homeDir(), ".config", "amp", "settings.json"),
    },
  ];

  const [vscodeStableDir, vscodeInsidersDir] = vscodeUserDirs();
  if (vscodeStableDir) {
    sources.push({
      id: "vscode",
      label: "VS Code",
      app: "VS Code",
      format: "standard",
      file: path.join(vscodeStableDir, "mcp.json"),
    });
  }
  if (vscodeInsidersDir) {
    sources.push({
      id: "vscode-insiders",
      label: "VS Code Insiders",
      app: "VS Code Insiders",
      format: "standard",
      file: path.join(vscodeInsidersDir, "mcp.json"),
    });
  }

  for (const [id, label, extensionId, fileName] of [
    ["cline", "Cline", "saoudrizwan.claude-dev", "cline_mcp_settings.json"],
    ["roo", "Roo Code", "rooveterinaryinc.roo-cline", "mcp_settings.json"],
    ["kilo", "Kilo Code", "kilocode.kilo-code", "mcp_settings.json"],
  ]) {
    for (const storage of extensionStorage(extensionId)) {
      const insiders = storage.toLowerCase().includes("insiders");
      sources.push({
        id: `${id}:${insiders ? "insiders" : "stable"}`,
        label: insiders ? `${label} (Insiders)` : label,
        app: label,
        format: "standard",
        file: path.join(storage, "settings", fileName),
      });
    }
  }

  return sources;
}

/** Project-level files, one candidate set per workspace root. */
export function projectSources(workspace) {
  const root = workspace;
  return [
    { id: "project:mcp-json", label: ".mcp.json", app: "Claude Code", format: "standard", file: path.join(root, ".mcp.json"), project: true },
    { id: "project:cursor", label: "Cursor project", app: "Cursor", format: "standard", file: path.join(root, ".cursor", "mcp.json"), project: true },
    { id: "project:vscode", label: "VS Code workspace", app: "VS Code", format: "standard", file: path.join(root, ".vscode", "mcp.json"), project: true },
    { id: "project:codex", label: "Codex project", app: "Codex", format: "codex", file: path.join(root, ".codex", "config.toml"), project: true },
    { id: "project:zed", label: "Zed project", app: "Zed", format: "zed", file: path.join(root, ".zed", "settings.json"), project: true },
    { id: "project:gemini", label: "Gemini project", app: "Gemini", format: "standard", file: path.join(root, ".gemini", "settings.json"), project: true },
    { id: "project:opencode", label: "OpenCode project", app: "OpenCode", format: "opencode", file: path.join(root, "opencode.json"), project: true },
    { id: "project:qwen", label: "Qwen project", app: "Qwen Code", format: "standard", file: path.join(root, ".qwen", "settings.json"), project: true },
    { id: "project:windsurf", label: "Windsurf project", app: "Windsurf", format: "standard", file: path.join(root, ".windsurf", "mcp_config.json"), project: true },
  ];
}

export function shortPath(value) {
  const home = homeDir();
  if (!value) return "";
  return value.toLowerCase().startsWith(home.toLowerCase()) ? `~${value.slice(home.length)}` : value;
}
