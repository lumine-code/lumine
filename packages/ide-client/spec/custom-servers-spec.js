const fs = require("fs");
const os = require("os");
const path = require("path");
const LanguageServerManager = require("../lib/language-server-manager");
const CustomServers = require("../lib/custom-servers");

describe("CustomServers", () => {
  let manager, filePath, customServers;

  const write = (value) => fs.writeFileSync(filePath, JSON.stringify(value));

  beforeEach(() => {
    manager = new LanguageServerManager();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "language-servers-"));
    filePath = path.join(dir, "language-servers.json");
    customServers = new CustomServers(manager, filePath);
  });

  afterEach(async () => {
    customServers.dispose();
    await manager.deactivate();
  });

  it("registers valid entries as config adapters", async () => {
    write({
      gopls: { command: "gopls", args: ["serve"], scopes: ["source.go"], settings: { a: 1 } },
    });
    customServers.load();
    const adapter = manager.adapters.get("config:gopls");
    expect(adapter.displayName).toBe("gopls");
    expect(adapter.grammarScopes).toEqual(["source.go"]);
    const launch = await adapter.resolveServer({ rootPath: "root" });
    expect(launch.args).toEqual(["serve"]);
    expect(launch.cwd).toBe("root");
    expect(launch.transport).toBe("stdio");
    expect(adapter.getSettings()).toEqual({ a: 1 });
    expect(adapter.getWorkspaceConfiguration("a")).toBe(1);
  });

  it("skips entries without command or scopes", () => {
    write({ broken: { args: [] }, alsoBroken: { command: "x", scopes: [] } });
    customServers.load();
    expect(manager.adapters.size).toBe(0);
  });

  it("keeps registrations when the file has a parse error", () => {
    write({ gopls: { command: "gopls", scopes: ["source.go"] } });
    customServers.load();
    fs.writeFileSync(filePath, "{ not json");
    customServers.load();
    expect(manager.adapters.has("config:gopls")).toBe(true);
  });

  it("re-registers only changed entries on reload", () => {
    write({
      gopls: { command: "gopls", scopes: ["source.go"] },
      stable: { command: "stable-ls", scopes: ["source.stable"] },
    });
    customServers.load();
    const before = manager.adapters.get("config:stable");
    write({
      gopls: { command: "gopls", args: ["-v"], scopes: ["source.go"] },
      stable: { command: "stable-ls", scopes: ["source.stable"] },
    });
    customServers.load();
    expect(manager.adapters.get("config:stable")).toBe(before);
    expect(manager.adapters.has("config:gopls")).toBe(true);
    write({ stable: { command: "stable-ls", scopes: ["source.stable"] } });
    customServers.load();
    expect(manager.adapters.has("config:gopls")).toBe(false);
    expect(manager.adapters.get("config:stable")).toBe(before);
  });
});
