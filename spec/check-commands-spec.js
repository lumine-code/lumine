const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/fs-temp").track();
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

  it("keeps handler and language-adapter labels outside command descriptors", () => {
    const root = temp.mkdirSync("lumine-check-commands-");
    fs.mkdirSync(path.join(root, "lib"));
    fs.writeFileSync(
      path.join(root, "lib", "main.js"),
      `lumine.commands.add("lumine-workspace", {
  "fixture:first": {
    description: "Run the first fixture action.",
    didDispatch() { notify({ displayName: "Notification title" }); },
  },
  "fixture:second": { didDispatch() {} },
});
const adapter = { displayName: "Fixture Language Server" };
`,
    );

    const commands = inventory("fixture", root);
    expect(commands.get("fixture:first").displayName).toBeNull();
    expect(commands.get("fixture:second").displayName).toBeNull();
    expect(commands.get("fixture:first").description).toBe("Run the first fixture action.");
  });

  it("preserves explicit labels on map, three-argument and JSX descriptors", () => {
    const root = temp.mkdirSync("lumine-check-commands-");
    fs.mkdirSync(path.join(root, "lib"));
    fs.writeFileSync(
      path.join(root, "lib", "main.jsx"),
      `lumine.commands.add("lumine-workspace", {
  "fixture:first": { displayName: "Fixture: First", didDispatch() {} },
});
lumine.commands.add("lumine-workspace", "fixture:second", {
  displayName: "An invalid rename must remain visible to the check",
  didDispatch() {},
});
const view = <Command command="fixture:third" displayName="Fixture: Third" callback={() => {}} />;
`,
    );

    const commands = inventory("fixture", root);
    expect(commands.get("fixture:first").displayName).toBe("Fixture: First");
    expect(commands.get("fixture:second").displayName).toBe(
      "An invalid rename must remain visible to the check",
    );
    expect(commands.get("fixture:third").displayName).toBe("Fixture: Third");
  });
});
