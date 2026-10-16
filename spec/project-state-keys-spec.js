const { getProjectStateKey, getWindowProjectStateKey } = require("../src/project-state-keys");

describe("project state keys", () => {
  it("identifies a project independently of root order", () => {
    expect(getProjectStateKey(["/b", "/a"])).toBe(getProjectStateKey(["/a", "/b"]));
  });

  it("gives different windows private keys for the same project", () => {
    expect(getWindowProjectStateKey("window-a", ["/project"])).not.toBe(
      getWindowProjectStateKey("window-b", ["/project"]),
    );
  });

  it("persists empty sessions privately without a shared project index", () => {
    expect(getProjectStateKey([])).toBeNull();
    expect(getWindowProjectStateKey("window-a", [])).toBe("editor-window-a-empty");
    expect(getWindowProjectStateKey("window-a", [])).not.toBe(
      getWindowProjectStateKey("window-b", []),
    );
  });
});
