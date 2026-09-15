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

  it("does not persist an empty project", () => {
    expect(getProjectStateKey([])).toBeNull();
    expect(getWindowProjectStateKey("window-a", [])).toBeNull();
  });
});
