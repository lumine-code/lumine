const fs = require("fs");
const { watchDirectory, watchFile, ripgrepPath } = require("lumine");

describe("the lumine module", () => {
  it("does not expose the removed Atom module", () => {
    expect(() => require("atom")).toThrow();
  });

  it("exposes the bundled ripgrep binary path", () => {
    expect(typeof ripgrepPath).toBe("string");
    expect(fs.existsSync(ripgrepPath)).toBe(true);
  });

  it("exposes the path watchers", () => {
    expect(typeof watchDirectory).toBe("function");
    expect(require("lumine").watchPath).toBeUndefined();
    expect(typeof watchFile).toBe("function");
  });
});
