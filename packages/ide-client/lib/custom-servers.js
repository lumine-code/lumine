const fs = require("fs");
const path = require("path");

// Wires user-defined language servers from <configDir>/language-servers.json
// without any adapter package. Each entry becomes a normal adapter
// registration; editing the file restarts exactly the affected servers.
//
//   {
//     "gopls": {
//       "command": "gopls",
//       "args": ["serve"],
//       "scopes": ["source.go"],
//       "settings": { "gopls": { "usePlaceholders": true } }
//     }
//   }

// spawn() with shell:false finds .exe on the Windows PATH but not .cmd/.bat
// shims (npm globals); resolve those explicitly.
const resolveCommand = (command) => {
  if (process.platform !== "win32" || command.includes("/") || command.includes("\\"))
    return command;
  const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";");
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of ["", ...extensions]) {
      const candidate = path.join(dir, command + extension);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return command;
};

const sectionLookup = (settings, section) =>
  section
    .split(".")
    .reduce(
      (value, key) => (value && typeof value === "object" ? value[key] : undefined),
      settings,
    );

module.exports = class CustomServers {
  constructor(manager, filePath = path.join(atom.getConfigDirPath(), "language-servers.json")) {
    this.manager = manager;
    this.filePath = filePath;
    this.registrations = new Map();
    this.watcher = null;
  }
  async activate() {
    this.load();
    try {
      const { watchPath } = require("atom");
      this.watcher = await watchPath(path.dirname(this.filePath), {}, (events) => {
        const relevant = events.some(
          (event) => event.path === this.filePath || event.oldPath === this.filePath,
        );
        if (relevant) this.load();
      });
    } catch {
      /* Watching is best-effort; the file is still read at startup. */
    }
  }
  read() {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch {
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      atom.notifications.addError("Invalid language-servers.json", {
        detail: `${this.filePath}\n${error.message}`,
        dismissable: true,
      });
      return null;
    }
  }
  load() {
    const entries = this.read();
    if (entries === null) return;
    const next = new Map();
    for (const [key, entry] of Object.entries(entries)) {
      if (!entry || typeof entry !== "object") continue;
      if (!entry.command || !Array.isArray(entry.scopes) || !entry.scopes.length) {
        atom.notifications.addWarning(
          `Custom language server '${key}' needs "command" and "scopes"`,
          { dismissable: true },
        );
        continue;
      }
      next.set(key, JSON.stringify(entry));
    }
    for (const [key, registration] of this.registrations) {
      if (next.get(key) !== registration.fingerprint) {
        registration.disposable.dispose();
        this.registrations.delete(key);
      }
    }
    for (const [key, fingerprint] of next) {
      if (this.registrations.has(key)) continue;
      const entry = JSON.parse(fingerprint);
      try {
        const disposable = this.manager.registerAdapter(this.buildAdapter(key, entry));
        this.registrations.set(key, { disposable, fingerprint });
      } catch (error) {
        atom.notifications.addError(`Unable to register custom language server '${key}'`, {
          detail: error.message,
          dismissable: true,
        });
      }
    }
  }
  buildAdapter(key, entry) {
    return {
      id: `config:${key}`,
      displayName: entry.displayName || key,
      grammarScopes: entry.scopes,
      languageId: entry.languageId,
      sessionScope: entry.sessionScope,
      resolveServer: async ({ rootPath }) => ({
        command: resolveCommand(entry.command),
        args: entry.args || [],
        cwd: rootPath,
        env: entry.env || {},
        transport: entry.transport || "stdio",
        host: entry.host,
        port: entry.port,
      }),
      getInitializationOptions: () => entry.initializationOptions,
      getSettings: () => entry.settings || {},
      getWorkspaceConfiguration: (section) =>
        section ? sectionLookup(entry.settings || {}, section) : entry.settings || {},
    };
  }
  openFile() {
    if (!fs.existsSync(this.filePath)) fs.writeFileSync(this.filePath, "{}\n");
    return atom.workspace.open(this.filePath);
  }
  dispose() {
    this.watcher?.dispose();
    for (const registration of this.registrations.values()) registration.disposable.dispose();
    this.registrations.clear();
  }
};
