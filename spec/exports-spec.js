const fs = require("fs");
const lumineExports = require("lumine");

describe("the lumine module", () => {
  it("does not expose the removed Atom module", () => {
    expect(() => require("atom")).toThrow();
  });

  it("exposes the bundled ripgrep binary path", () => {
    const { ripgrepPath } = lumineExports;
    expect(typeof ripgrepPath).toBe("string");
    expect(fs.existsSync(ripgrepPath)).toBe(true);
  });

  it("exposes the path watchers", () => {
    expect(typeof lumineExports.watchPath).toBe("function");
    expect(typeof lumineExports.watchFile).toBe("function");
  });
});
