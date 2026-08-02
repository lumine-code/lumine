const assert = require("./assert");
const parseCommandLine = require("../../src/parse-command-line");

describe("parseCommandLine", () => {
  // `LUMINE_DEV_MODE` forces dev mode regardless of arguments, so a developer
  // who exports it persistently would otherwise see every `devMode` assertion
  // here answer for their shell instead of for the arguments under test. Start
  // each spec from an unset variable and hand the real one back afterwards.
  let originalDevMode;

  beforeEach(() => {
    originalDevMode = process.env.LUMINE_DEV_MODE;
    delete process.env.LUMINE_DEV_MODE;
  });

  afterEach(() => {
    if (originalDevMode === undefined) {
      delete process.env.LUMINE_DEV_MODE;
    } else {
      process.env.LUMINE_DEV_MODE = originalDevMode;
    }
  });

  describe("when --uri-handler is not passed", () => {
    it("parses arguments as normal", () => {
      const args = parseCommandLine([
        "-d",
        "--safe",
        "--test",
        "/some/path",
        "lumine://test/url",
        "lumine://other/url",
      ]);
      assert.isTrue(args.devMode);
      assert.isTrue(args.safeMode);
      assert.isTrue(args.test);
      assert.deepEqual(args.urlsToOpen, ["lumine://test/url", "lumine://other/url"]);
      assert.deepEqual(args.pathsToOpen, ["/some/path"]);
    });

    // The "underscore flag" with no "non-flag argument" after it
    // is the minimal reproducer for the macOS Gatekeeper startup bug.
    // By default, it causes the addition of boolean "true"s into yargs' "non-flag argument" array: `argv._`
    // Whereas we do string-only operations on these arguments, expecting them to be paths or URIs.
    describe("and --_ or -_ are passed", () => {
      it("does not attempt to parse booleans as paths or URIs", () => {
        const args = parseCommandLine([
          "--_",
          "/some/path",
          "-_",
          "-_",
          "some/other/path",
          "lumine://test/url",
          "--_",
          "lumine://other/url",
          "-_",
          "./another-path.file",
          "-_",
          "-_",
          "-_",
        ]);
        assert.deepEqual(args.urlsToOpen, ["lumine://test/url", "lumine://other/url"]);
        assert.deepEqual(args.pathsToOpen, [
          "/some/path",
          "some/other/path",
          "./another-path.file",
        ]);
      });
    });

    describe("and a non-flag number is passed as an argument", () => {
      it("does not attempt to parse numbers as paths or URIs", () => {
        const args = parseCommandLine([
          "43",
          "/some/path",
          "22",
          "97",
          "some/other/path",
          "lumine://test/url",
          "885",
          "lumine://other/url",
          "42",
          "./another-path.file",
        ]);
        assert.deepEqual(args.urlsToOpen, ["lumine://test/url", "lumine://other/url"]);
        assert.deepEqual(args.pathsToOpen, [
          "/some/path",
          "some/other/path",
          "./another-path.file",
        ]);
      });
    });
  });

  describe("when --uri-handler is passed", () => {
    it("ignores other arguments and limits to one URL", () => {
      const args = parseCommandLine([
        "-d",
        "--uri-handler",
        "--safe",
        "--test",
        "/some/path",
        "lumine://test/url",
        "lumine://other/url",
      ]);
      assert.isUndefined(args.devMode);
      assert.isUndefined(args.safeMode);
      assert.isUndefined(args.test);
      assert.deepEqual(args.urlsToOpen, ["lumine://test/url"]);
      assert.deepEqual(args.pathsToOpen, []);
    });
  });

  describe("when LUMINE_DEV_MODE is set", () => {
    it("enables development mode without --dev", () => {
      process.env.LUMINE_DEV_MODE = "1";

      const args = parseCommandLine([]);

      assert.isTrue(args.devMode);
    });

    // The variable is the developer's own machine-wide choice and a URL cannot
    // reach it, so `--uri-handler` sanitizing the arguments is not a reason to
    // ignore it: a developer who opted into dev mode wants their `lumine://` URLs
    // to land in the dev instance too.
    it("still applies under --uri-handler, which only strips arguments", () => {
      process.env.LUMINE_DEV_MODE = "1";

      const args = parseCommandLine(["--uri-handler", "lumine://test/url"]);

      assert.isTrue(args.devMode);
      assert.deepEqual(args.urlsToOpen, ["lumine://test/url"]);
    });

    it("takes precedence over --no-dev", () => {
      process.env.LUMINE_DEV_MODE = "1";

      const args = parseCommandLine(["--no-dev"]);

      assert.isTrue(args.devMode);
    });

    it("does not enable development mode for other values", () => {
      process.env.LUMINE_DEV_MODE = "0";

      const args = parseCommandLine([]);

      assert.isUndefined(args.devMode);
    });
  });

  describe('when evil macOS Gatekeeper flag "-psn_0_[six or seven digits here]" is passed', () => {
    it('ignores any arguments starting with "-psn_"', () => {
      const getPsnFlag = () => {
        return `-psn_0_${Math.floor(Math.random() * 10_000_000)}`;
      };
      const args = parseCommandLine([
        getPsnFlag(),
        "/some/path",
        getPsnFlag(),
        getPsnFlag(),
        "some/other/path",
        "lumine://test/url",
        getPsnFlag(),
        "lumine://other/url",
        '-psn_ Any argument starting with "-psn_" should be ignored, even this one.',
        "./another-path.file",
      ]);
      assert.deepEqual(args.urlsToOpen, ["lumine://test/url", "lumine://other/url"]);
      assert.deepEqual(args.pathsToOpen, ["/some/path", "some/other/path", "./another-path.file"]);
    });
  });

  describe("package-management commands", () => {
    it("parses --install", () => {
      const args = parseCommandLine(["--install", "owner/repo"]);
      assert.deepEqual(args.packageCommand, { name: "install", arg: "owner/repo", dev: false });
      assert.deepEqual(args.pathsToOpen, []);
    });

    it("parses --uninstall", () => {
      const args = parseCommandLine(["--uninstall", "my-package"]);
      assert.deepEqual(args.packageCommand, { name: "uninstall", arg: "my-package", dev: false });
    });

    it("parses --list", () => {
      const args = parseCommandLine(["--list"]);
      assert.deepEqual(args.packageCommand, { name: "list", arg: null, dev: false });
    });

    it("parses --link with --dev", () => {
      const args = parseCommandLine(["--link", "/some/path", "--dev"]);
      assert.deepEqual(args.packageCommand, { name: "link", arg: "/some/path", dev: true });
    });

    it("parses --unlink", () => {
      const args = parseCommandLine(["--unlink", "my-package"]);
      assert.deepEqual(args.packageCommand, { name: "unlink", arg: "my-package", dev: false });
    });

    it("is null for a normal launch", () => {
      const args = parseCommandLine(["/some/path"]);
      assert.isNull(args.packageCommand);
    });
  });
});
