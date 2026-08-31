const fs = require("fs");
const os = require("os");
const path = require("path");

const createPathProvider = require("../src/icon-path-provider");
const { normalizeTarget } = require("../src/icon-target");

describe("the built-in path icon provider", () => {
  let provider;
  let tempDir;

  beforeEach(() => {
    provider = createPathProvider();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-path-"));
  });

  afterEach(() => {
    // Retries because Windows keeps a directory non-empty until the last handle on a child
    // closes, and `force` swallows only ENOENT.
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const classesFor = (target) => provider.iconFor(normalizeTarget(target))?.classes;

  const write = (name) => {
    const filePath = path.join(tempDir, name);
    fs.writeFileSync(filePath, "");
    return filePath;
  };

  it("only answers for path targets", () => {
    expect(provider.handles).toEqual(["path"]);
    expect(provider.iconFor(normalizeTarget({ path: "" }))).toBeNull();
  });

  describe("for paths that exist", () => {
    it("identifies directories", () => {
      const dirPath = path.join(tempDir, "sub");
      fs.mkdirSync(dirPath);
      expect(classesFor({ path: dirPath, hints: { directory: true } })).toEqual([
        "icon-file-directory",
      ]);
    });

    it("classifies files by extension", () => {
      expect(classesFor({ path: write("a.png") })).toEqual(["icon-file-media"]);
      expect(classesFor({ path: write("a.pdf") })).toEqual(["icon-file-pdf"]);
      expect(classesFor({ path: write("a.zip") })).toEqual(["icon-file-zip"]);
      expect(classesFor({ path: write("a.exe") })).toEqual(["icon-file-binary"]);
      expect(classesFor({ path: write("a.js") })).toEqual(["icon-file-text"]);
    });

    it("recognises readmes with and without an extension", () => {
      expect(classesFor({ path: write("README.md") })).toEqual(["icon-book"]);
      expect(classesFor({ path: write("readme") })).toEqual(["icon-book"]);
      expect(classesFor({ path: write("readme.js") })).toEqual(["icon-file-text"]);
    });
  });

  // Archive entries, remote items, and results for a file that has since been
  // deleted are all classified by name — only the directory and symlink checks
  // need the path to be on disk.
  describe("for paths that are not on disk", () => {
    it("still classifies by extension", () => {
      expect(classesFor({ path: "/nope/a.png" })).toEqual(["icon-file-media"]);
      expect(classesFor({ path: "/nope/a.pdf" })).toEqual(["icon-file-pdf"]);
      expect(classesFor({ path: "/nope/a.zip" })).toEqual(["icon-file-zip"]);
      expect(classesFor({ path: "/nope/sunn.o" })).toEqual(["icon-file-binary"]);
      expect(classesFor({ path: "/nope/README.md" })).toEqual(["icon-book"]);
    });

    it("falls back to the generic icon for unknown extensions", () => {
      expect(classesFor({ path: "/nope/a.qqq" })).toEqual(["icon-file-text"]);
    });
  });

  describe("when the caller supplies hints", () => {
    it("takes the caller's word for a directory without touching the disk", () => {
      const spy = spyOn(fs, "lstatSync").and.callThrough();
      expect(classesFor({ path: "/nope/thing", hints: { directory: true } })).toEqual([
        "icon-file-directory",
      ]);
      expect(spy).not.toHaveBeenCalled();
    });

    it("skips the disk for a file too", () => {
      const spy = spyOn(fs, "lstatSync").and.callThrough();
      expect(classesFor({ path: write("a.png"), hints: { directory: false } })).toEqual([
        "icon-file-media",
      ]);
      expect(spy).not.toHaveBeenCalled();
    });

    // A virtual path — an entry inside an archive — cannot be stat'd, and
    // trying costs a syscall per row for an answer that never arrives.
    it("skips the disk for virtual paths", () => {
      const spy = spyOn(fs, "lstatSync").and.callThrough();
      expect(classesFor({ path: "/a.zip/inner/x.png", hints: { virtual: true } })).toEqual([
        "icon-file-media",
      ]);
      expect(spy).not.toHaveBeenCalled();
    });

    // The order here is the one tree-view used before the registry owned it.
    it("ranks symlink over repository root over submodule", () => {
      const directory = { directory: true };
      expect(
        classesFor({ path: "/a", hints: { ...directory, symlink: true, repositoryRoot: true } }),
      ).toEqual(["icon-file-symlink-directory"]);
      expect(
        classesFor({ path: "/a", hints: { ...directory, repositoryRoot: true, submodule: true } }),
      ).toEqual(["icon-repo"]);
      expect(classesFor({ path: "/a", hints: { ...directory, submodule: true } })).toEqual([
        "icon-file-submodule",
      ]);
    });

    it("marks symlinked files", () => {
      expect(classesFor({ path: "/a/b.js", hints: { directory: false, symlink: true } })).toEqual([
        "icon-file-symlink-file",
      ]);
    });
  });
});
