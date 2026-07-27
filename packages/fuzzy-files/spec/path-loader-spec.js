const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/temp").track();

const PathLoader = require("../lib/path-loader");

function buildFixture() {
  const dir = fs.realpathSync.native(temp.mkdirSync("fuzzy-files-crawl-"));
  fs.writeFileSync(path.join(dir, "visible.txt"), "hello\n");
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "nested.txt"), "nested\n");
  fs.mkdirSync(path.join(dir, "vendor"));
  fs.writeFileSync(path.join(dir, "vendor", "lib.js"), "vendored\n");
  return dir;
}

function load() {
  return new Promise((resolve) => PathLoader.startTask(resolve));
}

function relativize(dir, paths) {
  return new Set(paths.map((p) => path.relative(dir, p).split(path.sep).join("/")));
}

describe("fuzzy-files path loader", () => {
  let dir;

  beforeEach(() => {
    dir = buildFixture();
    atom.project.setPaths([dir]);
    atom.config.set("fuzzy-files.ignoredNames", []);
    atom.config.set("core.ignoredNames", []);
  });

  it("collects every file under the project roots", async () => {
    const rels = relativize(dir, await load());

    expect(rels.has("visible.txt")).toBe(true);
    expect(rels.has("sub/nested.txt")).toBe(true);
  });

  it("applies the package's own ignored names on top of the editor's", async () => {
    atom.config.set("fuzzy-files.ignoredNames", ["vendor"]);
    const rels = relativize(dir, await load());

    expect(rels.has("visible.txt")).toBe(true);
    expect([...rels].some((rel) => rel.startsWith("vendor/"))).toBe(false);
  });

  it("does not report results after the crawl is terminated", async () => {
    let called = false;
    const crawl = PathLoader.startTask(() => {
      called = true;
    });
    crawl.terminate();

    await crawl;
    expect(called).toBe(false);
  });
});
