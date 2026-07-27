const path = require("path");

const IgnoredNames = require("../lib/ignored-names");

function matcherFor(ignoredNames) {
  atom.config.set("core.ignoredNames", ignoredNames);
  return new IgnoredNames();
}

describe("IgnoredNames", () => {
  it("matches a bare name anywhere in a path", () => {
    const ignored = matcherFor([".git"]);

    expect(ignored.matches(path.join("proj", ".git"))).toBe(true);
    expect(ignored.matches(path.join("proj", "src", "main.js"))).toBe(false);
  });

  // minimatch's `matchBase` applied only to patterns without a slash, so a
  // pattern with one has to be matched against the whole path. Mapping it to an
  // unconditional `basename` stopped these from ever matching.
  it("matches a pattern that contains a slash against the whole path", () => {
    const ignored = matcherFor(["**/node_modules/**"]);

    expect(ignored.matches("proj/node_modules/dep/index.js")).toBe(true);
    expect(ignored.matches("proj/src/index.js")).toBe(false);
  });

  it("matches dotfiles", () => {
    const ignored = matcherFor([".DS_Store"]);

    expect(ignored.matches(path.join("proj", ".DS_Store"))).toBe(true);
  });

  it("accepts a single name given as a string", () => {
    atom.config.set("core.ignoredNames", ".git");
    const ignored = new IgnoredNames();

    expect(ignored.matches(path.join("proj", ".git"))).toBe(true);
  });

  it("matches nothing when the list is empty", () => {
    const ignored = matcherFor([]);

    expect(ignored.matches(path.join("proj", ".git"))).toBe(false);
  });

  it("skips a pattern it cannot parse instead of throwing", () => {
    const ignored = matcherFor(["***/[", "*.log"]);

    expect(ignored.matches(path.join("proj", "debug.log"))).toBe(true);
  });
});
