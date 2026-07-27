const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/temp").track();

const RipgrepFileCrawler = require("../src/ripgrep-file-crawler");

const UNICODE_NAME = "café-δ.txt";

// Built at runtime rather than committed, so a literal `.git`/`.gitignore`
// never lands in the repository.
function buildFixture() {
  const dir = fs.realpathSync.native(temp.mkdirSync("file-crawler-"));
  fs.writeFileSync(path.join(dir, "visible.txt"), "hello\n");
  fs.writeFileSync(path.join(dir, "visible.md"), "hello\n");
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "nested.txt"), "nested\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n");
  fs.writeFileSync(path.join(dir, "ignored.txt"), "secret\n");
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, ".git", "config"), "[core]\n");
  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.writeFileSync(path.join(dir, "node_modules", "dep.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(dir, UNICODE_NAME), "unicode\n");
  return dir;
}

async function crawl(directoryPaths, options = {}) {
  const found = [];
  const crawler = new RipgrepFileCrawler();
  await crawler.crawl(directoryPaths, {
    ...options,
    didFindPaths: (paths) => found.push(...paths),
  });
  return found;
}

function relativize(dir, paths) {
  return new Set(paths.map((p) => path.relative(dir, p).split(path.sep).join("/")));
}

describe("RipgrepFileCrawler", () => {
  let dir;

  beforeEach(() => {
    dir = buildFixture();
  });

  it("lists files and hides VCS-ignored paths and .git contents by default", async () => {
    const rels = relativize(dir, await crawl([dir]));

    expect(rels.has("visible.txt")).toBe(true);
    expect(rels.has("sub/nested.txt")).toBe(true);
    expect(rels.has("ignored.txt")).toBe(false);
    expect([...rels].some((rel) => rel.startsWith(".git/"))).toBe(false);
  });

  it("reveals VCS-ignored files but still never descends into .git", async () => {
    const rels = relativize(dir, await crawl([dir], { excludeVcsIgnoredPaths: false }));

    expect(rels.has("ignored.txt")).toBe(true);
    expect([...rels].some((rel) => rel.startsWith(".git/"))).toBe(false);
  });

  it("excludes ignored names", async () => {
    const rels = relativize(dir, await crawl([dir], { ignoredNames: ["node_modules"] }));

    expect(rels.has("visible.txt")).toBe(true);
    expect([...rels].some((rel) => rel.startsWith("node_modules/"))).toBe(false);
  });

  it("scopes the crawl to an inclusion glob", async () => {
    const rels = relativize(dir, await crawl([dir], { inclusion: "**/*.md" }));

    expect(rels.has("visible.md")).toBe(true);
    expect(rels.has("visible.txt")).toBe(false);
  });

  // A positive `--glob` overrides ripgrep's ignore files, so an unconditional
  // include would silently defeat `core.excludeVcsIgnoredPaths`.
  it("does not let an inclusion of ** defeat the VCS-ignore setting", async () => {
    const rels = relativize(dir, await crawl([dir], { inclusion: "**" }));

    expect(rels.has("visible.txt")).toBe(true);
    expect(rels.has("ignored.txt")).toBe(false);
  });

  it("returns multibyte filenames intact", async () => {
    const rels = relativize(dir, await crawl([dir]));

    expect(rels.has(UNICODE_NAME)).toBe(true);
    for (const rel of rels) {
      expect(rel).not.toContain("�");
    }
  });

  it("emits a path reachable through two roots only once", async () => {
    const found = await crawl([dir, path.join(dir, "sub")]);
    const nested = found.filter((p) => path.basename(p) === "nested.txt");

    expect(nested.length).toBe(1);
  });

  it("resolves when cancelled before the crawl finishes", async () => {
    const crawler = new RipgrepFileCrawler();
    const pending = crawler.crawl([dir], { didFindPaths: () => {} });
    pending.cancel();

    await pending;
  });

  it("resolves for a directory that does not exist", async () => {
    const found = await crawl([path.join(dir, "nope")]);

    expect(found).toEqual([]);
  });
});
