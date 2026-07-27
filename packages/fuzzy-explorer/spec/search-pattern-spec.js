const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/temp").track();

const searchForPattern = require("../lib/search-pattern");

function buildFixture() {
  const dir = fs.realpathSync.native(temp.mkdirSync("fuzzy-explorer-pattern-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "main.js"), "\n");
  return dir;
}

describe("fuzzy-explorer search pattern", () => {
  let dir;

  beforeEach(() => {
    dir = buildFixture();
  });

  it("treats a plain directory as everything under it", () => {
    expect(searchForPattern(dir)).toEqual({ root: dir, include: "**" });
  });

  it("splits the literal prefix off as the root", () => {
    const search = searchForPattern(path.join(dir, "src", "**", "*.js"));

    expect(search.root).toBe(path.join(dir, "src"));
    expect(search.include).toBe("**/*.js");
  });

  it("scopes a file pattern to its parent directory", () => {
    const search = searchForPattern(path.join(dir, "src", "main.js"));

    expect(search.root).toBe(path.join(dir, "src"));
    expect(search.include).toBe("main.js");
  });

  // Windows only: on POSIX a backslash is an ordinary character in a filename,
  // so `dir\src\*.js` names one literal file rather than a pattern under `src`.
  if (process.platform === "win32") {
    it("accepts backslash separators", () => {
      const search = searchForPattern(`${dir}\\src\\*.js`);

      expect(search.root).toBe(path.join(dir, "src"));
      expect(search.include).toBe("*.js");
    });

    it("splits a backslash path the same way with no glob in it", () => {
      const search = searchForPattern(`${dir}\\src\\main.js`);

      expect(search.root).toBe(path.join(dir, "src"));
      expect(search.include).toBe("main.js");
    });
  }

  it("returns null when the root does not exist", () => {
    expect(searchForPattern(path.join(dir, "nope", "**"))).toBe(null);
  });
});
