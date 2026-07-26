const fs = require("fs");
const os = require("os");
const path = require("path");

const iconClassForPath = require("../src/icon-class-for-path");

describe("iconClassForPath", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-class-"));
    iconClassForPath.invalidateAll();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    iconClassForPath.invalidateAll();
  });

  const write = (name) => {
    const filePath = path.join(tempDir, name);
    fs.writeFileSync(filePath, "");
    return filePath;
  };

  describe("for paths that exist", () => {
    it("identifies directories", () => {
      const dirPath = path.join(tempDir, "sub");
      fs.mkdirSync(dirPath);
      expect(iconClassForPath(dirPath)).toEqual(["icon-file-directory"]);
    });

    it("classifies files by extension", () => {
      expect(iconClassForPath(write("a.png"))).toEqual(["icon-file-media"]);
      expect(iconClassForPath(write("a.pdf"))).toEqual(["icon-file-pdf"]);
      expect(iconClassForPath(write("a.zip"))).toEqual(["icon-file-zip"]);
      expect(iconClassForPath(write("a.exe"))).toEqual(["icon-file-binary"]);
      expect(iconClassForPath(write("a.js"))).toEqual(["icon-file-text"]);
    });

    it("recognises readmes with and without an extension", () => {
      expect(iconClassForPath(write("README.md"))).toEqual(["icon-book"]);
      expect(iconClassForPath(write("readme"))).toEqual(["icon-book"]);
      expect(iconClassForPath(write("readme.js"))).toEqual(["icon-file-text"]);
    });
  });

  // Archive entries, remote items, and results for a file that has since been
  // deleted are all classified by name — only the directory and symlink checks
  // need the path to be on disk.
  describe("for paths that are not on disk", () => {
    it("still classifies by extension", () => {
      expect(iconClassForPath("/nope/a.png")).toEqual(["icon-file-media"]);
      expect(iconClassForPath("/nope/a.pdf")).toEqual(["icon-file-pdf"]);
      expect(iconClassForPath("/nope/a.zip")).toEqual(["icon-file-zip"]);
      expect(iconClassForPath("/nope/sunn.o")).toEqual(["icon-file-binary"]);
      expect(iconClassForPath("/nope/README.md")).toEqual(["icon-book"]);
    });

    it("falls back to the generic icon for unknown extensions", () => {
      expect(iconClassForPath("/nope/a.qqq")).toEqual(["icon-file-text"]);
    });
  });

  describe("caching", () => {
    it("returns the same array for repeated lookups", () => {
      const filePath = write("a.png");
      expect(iconClassForPath(filePath)).toBe(iconClassForPath(filePath));
    });

    it("re-reads the path after invalidation", () => {
      const filePath = path.join(tempDir, "thing");
      fs.writeFileSync(filePath, "");
      expect(iconClassForPath(filePath)).toEqual(["icon-file-text"]);

      fs.unlinkSync(filePath);
      fs.mkdirSync(filePath);
      expect(iconClassForPath(filePath)).toEqual(["icon-file-text"]);

      iconClassForPath.invalidate(filePath);
      expect(iconClassForPath(filePath)).toEqual(["icon-file-directory"]);
    });
  });
});
