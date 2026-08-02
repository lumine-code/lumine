const path = require("path");

const { normalizeTarget, cacheKeyFor, defaultDataName } = require("../src/icon-target");

describe("icon targets", () => {
  describe("normalizeTarget", () => {
    it("rejects anything that is not an object", () => {
      expect(() => normalizeTarget("foo.js")).toThrow();
      expect(() => normalizeTarget(null)).toThrow();
      expect(() => normalizeTarget(undefined)).toThrow();
    });

    it("derives the type from which key is present", () => {
      expect(normalizeTarget({ path: "/a/b.js" }).type).toBe("path");
      expect(normalizeTarget({ name: "gear" }).type).toBe("name");
      expect(normalizeTarget({ kind: "class" }).type).toBe("kind");
      expect(normalizeTarget({}).type).toBe("none");
    });

    it("keeps only the key matching the type", () => {
      const target = normalizeTarget({ name: "gear", path: "/a/b.js" });
      expect(target.type).toBe("name");
      expect(target.name).toBe("gear");
      expect(target.path).toBeNull();
    });

    describe("for a pane item", () => {
      it("prefers getIconName over the item's path", () => {
        const item = { getIconName: () => "markdown", getPath: () => "/a/b.md" };
        const target = normalizeTarget({ item });
        expect(target.type).toBe("name");
        expect(target.name).toBe("markdown");
      });

      it("falls back to the path when getIconName returns nothing", () => {
        const item = { getIconName: () => null, getPath: () => "/a/b.md" };
        expect(normalizeTarget({ item }).path).toBe("/a/b.md");
      });

      it("falls back to a URI only when it is not a scheme", () => {
        expect(normalizeTarget({ item: { getURI: () => "/a/b.md" } }).path).toBe("/a/b.md");
        expect(normalizeTarget({ item: { getURI: () => "lumine://config" } }).type).toBe("none");
      });

      it("lets an explicit path or name on the target win", () => {
        const item = { getIconName: () => "markdown" };
        expect(normalizeTarget({ item, name: "search" }).name).toBe("search");
      });
    });

    describe("hints", () => {
      it("keeps absent hints undefined rather than false", () => {
        const target = normalizeTarget({ path: "/a", hints: { directory: true } });
        expect(target.hints.directory).toBe(true);
        expect(target.hints.symlink).toBeUndefined();
      });

      it("coerces supplied hints to booleans", () => {
        const target = normalizeTarget({ path: "/a", hints: { directory: 1, symlink: 0 } });
        expect(target.hints.directory).toBe(true);
        expect(target.hints.symlink).toBe(false);
      });
    });
  });

  describe("cacheKeyFor", () => {
    it("separates the three vocabularies", () => {
      const keys = [
        cacheKeyFor(normalizeTarget({ path: "x" })),
        cacheKeyFor(normalizeTarget({ name: "x" })),
        cacheKeyFor(normalizeTarget({ kind: "x" })),
      ];
      expect(new Set(keys).size).toBe(3);
    });

    // A tree view knows a path is a directory; a fuzzy finder does not. They
    // must not share a cache entry, or whichever asked first wins forever.
    it("distinguishes a known hint from an unknown one", () => {
      const known = cacheKeyFor(normalizeTarget({ path: "/a", hints: { directory: false } }));
      const unknown = cacheKeyFor(normalizeTarget({ path: "/a" }));
      const other = cacheKeyFor(normalizeTarget({ path: "/a", hints: { directory: true } }));
      expect(known).not.toBe(unknown);
      expect(known).not.toBe(other);
    });

    it("includes the context only when asked to", () => {
      const withContext = normalizeTarget({ path: "/a", context: "tabs" });
      const without = normalizeTarget({ path: "/a" });
      expect(cacheKeyFor(withContext)).not.toBe(cacheKeyFor(without));
      expect(cacheKeyFor(withContext, { context: false })).toBe(
        cacheKeyFor(without, { context: false }),
      );
    });

    it("has no key for an empty target", () => {
      expect(cacheKeyFor(normalizeTarget({}))).toBeNull();
    });
  });

  describe("defaultDataName", () => {
    it("is the basename of a path target", () => {
      expect(defaultDataName(normalizeTarget({ path: path.join("a", "b", "c.js") }))).toBe("c.js");
    });

    it("is nothing for a name or kind target", () => {
      expect(defaultDataName(normalizeTarget({ name: "gear" }))).toBeNull();
      expect(defaultDataName(normalizeTarget({ kind: "class" }))).toBeNull();
    });
  });
});
