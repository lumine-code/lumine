const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/temp").track();

function buildFixture() {
  const dir = fs.realpathSync.native(temp.mkdirSync("project-list-glob-"));
  fs.mkdirSync(path.join(dir, "alpha"));
  fs.mkdirSync(path.join(dir, "beta"));
  fs.writeFileSync(path.join(dir, "loose.txt"), "not a project\n");
  return dir;
}

describe("project-list glob path expansion", () => {
  let dir, projectList;

  beforeEach(async () => {
    dir = buildFixture();
    const pack = await atom.packages.activatePackage("project-list");
    projectList = pack.mainModule.projectList;
  });

  it("expands a glob to the directories it matches", async () => {
    const expanded = await projectList.expandGlobPaths([path.join(dir, "*")]);

    expect(expanded).toEqual([path.join(dir, "alpha"), path.join(dir, "beta")]);
  });

  it("does not expand matched directories recursively", async () => {
    fs.mkdirSync(path.join(dir, "alpha", "nested"));

    const expanded = await projectList.expandGlobPaths([path.join(dir, "alph?")]);

    expect(expanded).toEqual([path.join(dir, "alpha")]);
  });

  it("never expands to a file", async () => {
    const expanded = await projectList.expandGlobPaths([path.join(dir, "*")]);

    expect(expanded).not.toContain(path.join(dir, "loose.txt"));
  });

  it("passes a literal path through untouched", async () => {
    const literal = path.join(dir, "alpha");

    expect(await projectList.expandGlobPaths([literal])).toEqual([literal]);
  });

  it("passes a literal path through even when it does not exist", async () => {
    const missing = path.join(dir, "does-not-exist");

    expect(await projectList.expandGlobPaths([missing])).toEqual([missing]);
  });

  // Windows only: on POSIX a backslash is an ordinary character in a filename,
  // so `dir\*` names one literal file rather than globbing `dir`.
  if (process.platform === "win32") {
    it("accepts backslash separators in a pattern", async () => {
      const expanded = await projectList.expandGlobPaths([`${dir}\\*`]);

      expect(expanded).toEqual([path.join(dir, "alpha"), path.join(dir, "beta")]);
    });
  }

  it("sorts the combined result", async () => {
    const expanded = await projectList.expandGlobPaths([
      path.join(dir, "beta"),
      path.join(dir, "alpha"),
    ]);

    expect(expanded).toEqual([path.join(dir, "alpha"), path.join(dir, "beta")]);
  });
});
