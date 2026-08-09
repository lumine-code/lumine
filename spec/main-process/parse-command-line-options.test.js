const assert = require("./assert");
const parseCommandLineOptions = require("../../src/parse-command-line-options");
const { getAppArguments } = parseCommandLineOptions;

describe("parseCommandLineOptions", () => {
  it("parses long, short, bundled, attached, and launcher options", () => {
    const args = parseCommandLineOptions([
      "-dt",
      "-rC:/lumine",
      "--user-data-dir=C:/profile",
      "--pid",
      "42",
      "--no-safe",
    ]);

    assert.isTrue(args.dev);
    assert.isTrue(args.test);
    assert.equal(args["resource-path"], "C:/lumine");
    assert.equal(args["user-data-dir"], "C:/profile");
    assert.equal(args.pid, 42);
    assert.isFalse(args.safe);
  });

  it("keeps values after -- positional and ignores unknown Electron switches", () => {
    const args = parseCommandLineOptions(["--no-sandbox", "file.js", "--", "-literal-name", "43"]);

    assert.deepEqual(args._, ["file.js", "-literal-name", 43]);
  });

  it("ignores macOS process serial number and underscore flags", () => {
    const args = parseCommandLineOptions(["-psn_0_123456", "--_", "first.js", "-_", "second.js"]);

    assert.deepEqual(args._, ["first.js", "second.js"]);
  });

  it("removes the app path from source-launch arguments", () => {
    const args = getAppArguments(
      ["electron", "--no-sandbox", "--enable-logging", ".", "--test", "spec/main.js"],
      { defaultApp: true, appPath: process.cwd() },
    );

    assert.deepEqual(args, ["--no-sandbox", "--enable-logging", "--test", "spec/main.js"]);
  });

  it("leaves packaged-launch arguments unchanged", () => {
    const args = getAppArguments(["lumine", "--test", "spec/main.js"], {
      defaultApp: false,
      appPath: process.cwd(),
    });

    assert.deepEqual(args, ["--test", "spec/main.js"]);
  });
});
