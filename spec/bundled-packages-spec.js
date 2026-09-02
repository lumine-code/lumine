const path = require("path");
const {
  isLuminePackageDir,
  scanBundledPackageNames,
  resolveBundledPackageDir,
  clearCache,
} = require("../src/bundled-packages");

// The scan in src/bundled-packages.js is the single definition of "bundled":
// a dependency is a Lumine package iff its installed manifest declares an
// engines.lumine range. The count is a tripwire, like EXPECTED_GRAMMAR_COUNT
// in the grammar sweep: adding or dropping a bundled package means updating
// it deliberately, and a partial node_modules cannot silently shrink the set.
const EXPECTED_BUNDLED_COUNT = 51;

describe("bundled-packages", function () {
  const repoRoot = path.resolve(__dirname, "..");

  it("finds every bundled package and no library", function () {
    const names = scanBundledPackageNames(repoRoot);
    expect(names.length).toBe(EXPECTED_BUNDLED_COUNT);
    expect(names).toContain("about");
    expect(names).toContain("settings-view");
    expect(names).toContain("language-c");
    // snippets and language-source are bundled because core assumes them: core
    // seeds ~/.lumine/snippets.json and ships File > Open Your Snippets, and
    // language-source carries the base .source indent and comment settings every
    // source.* grammar without its own settings/ falls back to.
    expect(names).toEqual(
      jasmine.arrayContaining([
        "snippets",
        "language-source",
        "language-gfm",
        "language-git",
        "language-ipython",
        "language-log",
        "language-regex",
      ]),
    );
    // Deliberately unbundled — in packages/index.json, installed on demand.
    expect(names).not.toContain("autocomplete");
    expect(names).not.toContain("bracket-matcher");
    expect(names).not.toContain("fuzzy-files");
    expect(names).not.toContain("markdown-preview");
    expect(names).not.toContain("semver");
    expect(names).not.toContain("@lumine-code/fs-plus");
  });

  it("rejects a directory whose manifest declares no lumine engine", function () {
    expect(isLuminePackageDir(path.join(repoRoot, "node_modules", "semver"))).toBe(false);
    expect(isLuminePackageDir(path.join(repoRoot, "node_modules", "no-such-dir"))).toBe(false);
  });

  it("resolves every scanned name to a package directory", function () {
    for (const name of scanBundledPackageNames(repoRoot)) {
      expect(resolveBundledPackageDir(repoRoot, name)).not.toBe(null);
    }
  });

  it("memoizes per root until the cache is cleared", function () {
    const first = scanBundledPackageNames(repoRoot);
    expect(scanBundledPackageNames(repoRoot)).toBe(first);
    clearCache();
    const second = scanBundledPackageNames(repoRoot);
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });
});
