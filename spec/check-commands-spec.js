const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/temp").track();
const { inventory } = require("../script/check-commands");

describe("check-commands", () => {
  afterEach(() => temp.cleanupSync());

  it("reads command metadata from an imported literal used by a registration loop", () => {
    const root = temp.mkdirSync("lumine-check-commands-");
    fs.mkdirSync(path.join(root, "lib"));
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "fixture",
      }),
    );
    fs.writeFileSync(
      path.join(root, "lib", "actions.js"),
      `const ACTIONS = [
  { action: "first", detail: "Run the first fixture action." },
  { action: "second", detail: "Run the second fixture action." },
];
module.exports = { ACTIONS };
`,
    );
    fs.writeFileSync(
      path.join(root, "lib", "main.js"),
      `const { ACTIONS } = require("./actions");
module.exports = {
  activate() {
    const commands = {};
    for (const item of ACTIONS) {
      commands[\`fixture:\${item.action}\`] = {
        description: item.detail,
        didDispatch() {},
      };
    }
    lumine.commands.add("lumine-workspace", commands);
  },
};
`,
    );

    const commands = inventory("fixture", root);
    expect(commands.get("fixture:first").description).toBe("Run the first fixture action.");
    expect(commands.get("fixture:second").description).toBe("Run the second fixture action.");
  });
});
