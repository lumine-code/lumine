const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const PackageStorage = require("../src/package-storage");
const { updateRecentItemIds } = require("lumine");

describe("select-list recent intents across independent windows", () => {
  let directory, base, managers, hosts, extra, notifications;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    base = fs.realpathSync.native(os.tmpdir());
    directory = fs.mkdtempSync(path.join(base, "lumine-recent-windows-"));
    managers = [];
    hosts = [];
    notifications = [];
    extra = await lumine.workspace.openEditorWindow({ show: false });
  });

  afterEach(async () => {
    await Promise.all(hosts.map((host) => host.destroy()));
    await Promise.all(managers.map((manager) => manager.close()));
    await lumine.workspace.closeEditorWindow(extra);
    if (path.dirname(fs.realpathSync.native(directory)) !== base)
      throw new Error("Recent-list profile escaped its temporary parent");
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function lists({ synchronize = true, scope = "globalState" } = {}) {
    for (let index = 0; index < 2; index++) {
      const manager = new PackageStorage({
        onDidCommit: synchronize
          ? (change) => {
              const updating = Promise.all(managers.map((other) => other.reloadScope(change)));
              notifications.push(updating);
              return updating;
            }
          : undefined,
      });
      managers.push(manager);
      await manager.initialize({
        configDirPath: directory,
        windowStateId: `recents-window-${index}`,
        projectPaths: ["recent-project"],
      });
    }
    const states = managers.map((manager) => manager.forPackage("recent-list-spec")[scope]);
    await states[0].update("recent", ["old"]);
    await managers[1].reloadScope({
      scopeId: scope === "globalState" ? "global" : managers[1].projectScopeId,
      revision: Infinity,
      sourceId: "fixture",
    });
    for (const [index, state] of states.entries()) {
      const host = lumine.workspace.addSelectList(
        {
          items: ["a", "b", "old"],
          renderItem: (item) => ({ primary: item }),
          recents: {
            limit: 10,
            adapter: {
              serializesWrites: true,
              load: () => state.get("recent", []),
              save: (ids, change) =>
                state.mutate("recent", (current = []) => updateRecentItemIds(current, ids, change)),
              onDidChange: (callback) => {
                let initial = true;
                return state.observe("recent", (ids) => {
                  if (initial) initial = false;
                  else callback(ids ?? []);
                });
              },
            },
          },
          commands: { "recent-list-spec:use": () => {} },
          actions: [
            {
              command: "recent-list-spec:use",
              context: "item",
              primary: true,
              recordsRecent: true,
              disposition: "stay",
            },
          ],
        },
        { window: index === 0 ? lumine.workspace.getMainWindow() : extra },
      );
      hosts.push(host);
      await host.show();
    }
    return { states, models: hosts.map((host) => host.getModel()) };
  }

  it("records both concurrent semantic actions and projects the committed order to both lists", async () => {
    const {
      states,
      models: [a, b],
    } = await lists();
    await a.selectItemById("a");
    await b.selectItemById("b");
    await Promise.all([a.confirmSelection(), b.confirmSelection()]);
    await Promise.all(notifications);
    const ids = states[0].get("recent");
    expect(ids.slice(0, 2).sort()).toEqual(["a", "b"]);
    expect(ids[2]).toBe("old");
    expect(a.getRecentItemIds()).toEqual(ids);
    expect(b.getRecentItemIds()).toEqual(ids);
    expect(a.getElement().ownerDocument).not.toBe(b.getElement().ownerDocument);
  });

  it("applies stale clear, removal, limit and replacement intentions without reviving history", async () => {
    const {
      states,
      models: [a, b],
    } = await lists({ synchronize: false });
    await b.clearRecentItems();
    await a.recordRecentItem("a");
    expect(states[0].get("recent")).toEqual(["a"]);
    await a.recordRecentItem("b");
    await b.removeRecentItem("a");
    expect(states[1].get("recent")).toEqual(["b"]);
    await b.recordRecentItem("old");
    await a.setRecentLimit(1);
    expect(states[0].get("recent")).toEqual(["old"]);
    await b.setRecentItemIds(["a"]);
    expect(states[1].get("recent")).toEqual(["a"]);
  });

  it("discards an old project's canonical save result after an equal-valued project rebind", async () => {
    const {
      states,
      models: [a],
    } = await lists({ synchronize: false, scope: "workspaceState" });
    const manager = managers[0];
    await manager.switchProject(["next-project"]);
    await states[0].update("recent", ["old"]);
    await manager.switchProject(["recent-project"]);
    let release;
    const blocking = manager.enqueue(() => new Promise((resolve) => (release = resolve)));
    await conditionPromise(() => Boolean(release));
    const saving = a.recordRecentItem("a");
    const switching = manager.switchProject(["next-project"]);
    try {
      expect(a.getRecentItemIds()).toEqual(["old"]);
    } finally {
      release();
    }
    await Promise.all([blocking, saving, switching]);
    expect(states[0].get("recent")).toEqual(["old"]);
    expect(a.getRecentItemIds()).toEqual(["old"]);
    await manager.switchProject(["recent-project"]);
    expect(a.getRecentItemIds()).toEqual(["a", "old"]);
  });

  for (const dispose of [false, true]) {
    it(`captures the project for a second pending clear${dispose ? " even after disposal" : ""}`, async () => {
      const {
        states,
        models: [a],
      } = await lists({ synchronize: false, scope: "workspaceState" });
      const manager = managers[0];
      await manager.switchProject(["next-project"]);
      await states[0].update("recent", ["keep-next"]);
      await manager.switchProject(["recent-project"]);
      let release;
      const blocking = manager.enqueue(() => new Promise((resolve) => (release = resolve)));
      await conditionPromise(() => Boolean(release));
      const recording = a.recordRecentItem("a");
      const clearing = a.clearRecentItems();
      let switching;
      try {
        if (dispose) await a.destroy();
        switching = manager.switchProject(["next-project"]);
      } finally {
        release();
      }
      await Promise.all([blocking, recording, clearing, switching]);
      expect(states[0].get("recent")).toEqual(["keep-next"]);
      await manager.switchProject(["recent-project"]);
      expect(states[0].get("recent")).toEqual([]);
      if (!dispose) expect(a.getRecentItemIds()).toEqual([]);
    });
  }
});
