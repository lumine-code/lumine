const fs = require("fs");
const atomExports = require("atom");

describe("the atom module", () => {
  it("exposes the bundled ripgrep binary path", () => {
    const { ripgrepPath } = atomExports;
    expect(typeof ripgrepPath).toBe("string");
    expect(fs.existsSync(ripgrepPath)).toBe(true);
  });

  it("exposes the path watchers", () => {
    expect(typeof atomExports.watchPath).toBe("function");
    expect(typeof atomExports.watchFile).toBe("function");
  });
});
