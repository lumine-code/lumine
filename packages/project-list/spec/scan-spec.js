const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/temp").track();

const scanHandler = require("../lib/scan");

function buildFixture() {
  const dir = fs.realpathSync.native(temp.mkdirSync("project-list-scan-"));
  fs.mkdirSync(path.join(dir, "alpha"));
  fs.mkdirSync(path.join(dir, "beta"));
  fs.mkdirSync(path.join(dir, "beta", "nested"));
  fs.writeFileSync(path.join(dir, "loose.txt"), "not a project\n");
  return dir;
}

// `scan` is a Task handler: it emits `project-list:entries` and takes no
// completion callback. Drive it directly so the test exercises the real walk.
function run(dirPath, scanList) {
  let collected = [];
  const originalEmit = global.emit;
  global.emit = (event, entries) => {
    if (event === "project-list:entries") collected = entries;
  };
  try {
    scanHandler(dirPath, scanList);
  } finally {
    global.emit = originalEmit;
  }
  return collected;
}

describe("project-list scan handler", () => {
  let dir;

  beforeEach(() => {
    dir = buildFixture();
  });

  it("lists the directories one level down", () => {
    const entries = run(dir, "*/").sort();

    expect(entries).toEqual(["alpha", "beta"]);
  });

  it("never lists files", () => {
    const entries = run(dir, "*");

    expect(entries).not.toContain("loose.txt");
  });

  it("returns entries without a trailing separator", () => {
    for (const entry of run(dir, "*/")) {
      expect(entry).not.toMatch(/[\\/]$/);
    }
  });

  it("follows a deeper pattern", () => {
    expect(run(dir, "beta/*/")).toEqual(["beta/nested"]);
  });

  it("does not expand matched directories recursively", () => {
    expect(run(dir, "bet?")).toEqual(["beta"]);
  });

  it("returns nothing when the pattern matches no directory", () => {
    expect(run(dir, "gamma/*/")).toEqual([]);
  });
});
