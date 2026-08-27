const fs = require("@lumine-code/fs-plus");

const { compile, merge, toRipgrepGlobArgs, toRipgrepGlobs } = require("../src/ignored-names");

describe("ignored names", () => {
  it("normalizes and deduplicates portable patterns", () => {
    expect(merge(["node_modules", "build\\output/"], ["node_modules", "./dist"])).toEqual([
      "node_modules",
      "build/output",
      "/dist",
    ]);
  });

  it("matches slashless patterns against every path component", () => {
    const matcher = compile(["node_modules", "*.pyc"]);

    expect(matcher.matches("node_modules/dep.js")).toBe(true);
    expect(matcher.matches("packages/node_modules/dep.js")).toBe(true);
    expect(matcher.matches("src/cache/value.pyc")).toBe(true);
    expect(matcher.matches("src/not_node_modules/value.py")).toBe(false);
  });

  it("anchors patterns containing a slash and carries directory matches to descendants", () => {
    const matcher = compile(["build/output", "/dist"]);

    expect(matcher.matches("build/output/bundle.js")).toBe(true);
    expect(matcher.matches("a/build/output/bundle.js")).toBe(false);
    expect(matcher.matches("dist/app.js")).toBe(true);
    expect(matcher.matches("packages/dist/app.js")).toBe(false);
  });

  it("accepts either path separator and treats a leading bang literally", () => {
    const matcher = compile(["deep\\cache", "!literal"]);

    expect(matcher.matches("deep\\cache\\value.txt")).toBe(true);
    expect(matcher.matches("src/!literal/file.txt")).toBe(true);
    expect(matcher.matches("src/literal/file.txt")).toBe(false);
  });

  it("keeps to the glob syntax shared with ripgrep", () => {
    const matcher = compile(["@(src|spec)"]);

    expect(matcher.matches("src/file.js")).toBe(false);
    expect(matcher.matches("spec/file.js")).toBe(false);
  });

  it("uses the filesystem's case sensitivity", () => {
    const matcher = compile(["Cache"]);

    expect(matcher.matches("src/cache/value.txt")).toBe(fs.isCaseInsensitive());
  });

  it("returns an immutable snapshot", () => {
    const matcher = compile(["one", "two"]);

    expect(Object.isFrozen(matcher)).toBe(true);
    expect(Object.isFrozen(matcher.patterns)).toBe(true);
    expect(matcher.patterns).toEqual(["one", "two"]);
  });

  it("generates filesystem-sensitive ripgrep exclusion arguments", () => {
    expect(toRipgrepGlobArgs(["Cache"], { exclude: true })).toEqual([
      fs.isCaseInsensitive() ? "--iglob" : "--glob",
      "!Cache",
    ]);
  });

  it("drops an invalid glob and warns only once", () => {
    const warn = spyOn(console, "warn");
    const invalid = "unique-unclosed-[";

    expect(compile([invalid]).patterns).toEqual([]);
    expect(toRipgrepGlobs([invalid])).toEqual([]);
    expect(warn.calls.count()).toBe(1);
  });
});
