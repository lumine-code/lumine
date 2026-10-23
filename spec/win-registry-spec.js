const ChildProcess = require("child_process");
const Registry = require("../src/win-registry");
const path = require("path");
const winShell = require("../src/win-shell");

// Regression coverage for the winreg replacement. The whole point of this module
// is to talk to reg.exe *without* `shell: true`, which Node deprecates (DEP0190)
// when arguments are passed as an array. Most specs stub execFile so they run on
// every CI platform; one Windows-only smoke test exercises the real reg.exe.

describe("win-registry", function () {
  describe("constructor", function () {
    it("rejects an unknown hive", function () {
      expect(() => new Registry({ hive: "BOGUS", key: "\\x" })).toThrow();
    });

    it("builds an unquoted reg path from hive and key", function () {
      const reg = new Registry({ hive: "HKCU", key: "\\Software\\Lumine" });
      expect(reg.path).toBe("HKCU\\Software\\Lumine");
    });
  });

  describe("when talking to reg.exe", function () {
    let execFileSpy;

    beforeEach(function () {
      execFileSpy = spyOn(ChildProcess, "execFile");
    });

    function lastCall() {
      return execFileSpy.calls.mostRecent().args;
    }

    it("never spawns with a shell (avoids DEP0190)", function () {
      execFileSpy.and.callFake((file, args, options, cb) => cb(null, ""));

      new Registry({ hive: "HKCU", key: "\\Software\\Lumine" }).keyExists(() => {});

      const [file, args, options] = lastCall();
      expect(file).toContain("reg.exe");
      expect(Array.isArray(args)).toBe(true);
      expect(options.shell).not.toBe(true);
      expect(options.shell).toBeUndefined();
      expect(options.windowsHide).toBe(true);
    });

    if (process.platform === "win32") {
      it("uses SystemRoot before windir instead of searching PATH", () => {
        const previousRoot = process.env.SystemRoot;
        const previousWindir = process.env.windir;
        try {
          process.env.SystemRoot = "C:\\Windows Root";
          process.env.windir = "C:\\Other Windows";
          execFileSpy.and.callFake((file, args, options, cb) => cb(null, ""));

          new Registry({ key: "\\Software\\Lumine" }).keyExists(() => {});

          expect(lastCall()[0]).toBe(path.join(process.env.SystemRoot, "System32", "reg.exe"));
          delete process.env.SystemRoot;
          new Registry({ key: "\\Software\\Lumine" }).keyExists(() => {});
          expect(lastCall()[0]).toBe(path.join(process.env.windir, "System32", "reg.exe"));
        } finally {
          if (previousRoot === undefined) delete process.env.SystemRoot;
          else process.env.SystemRoot = previousRoot;
          if (previousWindir === undefined) delete process.env.windir;
          else process.env.windir = previousWindir;
        }
      });
    }

    it("writes string values with literal quotes, spaces and shell placeholders", () => {
      execFileSpy.and.callFake((file, args, options, cb) => cb(null, ""));
      const value = '"C:\\Program Files\\Lumine\\lumine.exe" "%1" & %V';
      let result;

      new Registry({ key: "\\Software\\Lumine Test" }).setString("", value, (error) => {
        result = error;
      });

      expect(lastCall()[1]).toEqual([
        "ADD",
        "HKLM\\Software\\Lumine Test",
        "/ve",
        "/t",
        "REG_SZ",
        "/d",
        value,
        "/f",
      ]);
      expect(lastCall()[2].shell).not.toBe(true);
      expect(lastCall()[2].windowsHide).toBe(true);
      expect(result).toBeNull();
    });

    it("registers every application and context-menu value through the same writer", () => {
      execFileSpy.and.callFake((file, args, options, cb) => cb(null, ""));

      for (const option of [
        winShell.fileHandler,
        winShell.fileContextMenu,
        winShell.folderContextMenu,
        winShell.folderBackgroundContextMenu,
      ]) {
        execFileSpy.calls.reset();
        const callback = jasmine.createSpy("registered");
        option.register(callback);

        const writes = execFileSpy.calls.allArgs().filter(([, args]) => args[0] === "ADD");
        expect(writes.length).toBe(option.parts.length);
        for (const [index, [file, args, options]] of writes.entries()) {
          const part = option.parts[index];
          expect(file).toContain("reg.exe");
          expect(options.windowsHide).toBe(true);
          expect(options.shell).not.toBe(true);
          expect(args[args.indexOf("/d") + 1]).toBe(part.value);
        }
        expect(callback).toHaveBeenCalledTimes(1);
      }
    });

    it("reports registration failures without claiming success or deleting obsolete keys", () => {
      const error = Object.assign(new Error("access denied"), { code: 5 });
      execFileSpy.and.callFake((file, args, options, cb) => cb(error, ""));
      const callback = jasmine.createSpy("registered");

      winShell.fileContextMenu.register(callback);

      expect(callback).toHaveBeenCalledOnceWith(error);
      expect(execFileSpy.calls.allArgs().every(([, args]) => args[0] === "ADD")).toBe(true);
    });

    it("queries the default value and parses it", function () {
      execFileSpy.and.callFake((file, args, options, cb) =>
        cb(null, "\r\nHKEY_CLASSES_ROOT\\.txt\r\n    (Default)    REG_SZ    txtfilelegacy\r\n\r\n"),
      );

      let result;
      new Registry({ hive: "HKCR", key: "\\.txt" }).get("", (err, item) => {
        result = { err, item };
      });

      expect(lastCall()[1]).toEqual(["QUERY", "HKCR\\.txt", "/ve"]);
      expect(result.err).toBeNull();
      expect(result.item.type).toBe("REG_SZ");
      expect(result.item.value).toBe("txtfilelegacy");
    });

    it("queries a named value", function () {
      execFileSpy.and.callFake((file, args, options, cb) =>
        cb(null, "\r\nHKEY_CURRENT_USER\\X\r\n    Hidden    REG_DWORD    0x1\r\n\r\n"),
      );

      let result;
      new Registry({ hive: "HKCU", key: "\\X" }).get("Hidden", (err, item) => {
        result = { err, item };
      });

      expect(lastCall()[1]).toEqual(["QUERY", "HKCU\\X", "/v", "Hidden"]);
      expect(result.item.name).toBe("Hidden");
      expect(result.item.value).toBe("0x1");
    });

    it("reports a missing value as null with the error forwarded", function () {
      const err = new Error("not found");
      err.code = 1;
      execFileSpy.and.callFake((file, args, options, cb) => cb(err, ""));

      let result;
      new Registry({ hive: "HKCU", key: "\\Missing" }).get("", (e, item) => {
        result = { e, item };
      });

      expect(result.e).toBe(err);
      expect(result.item).toBeNull();
    });

    it("maps exit code 1 to keyExists=false", function () {
      const err = new Error("not found");
      err.code = 1;
      execFileSpy.and.callFake((file, args, options, cb) => cb(err));

      let result;
      new Registry({ hive: "HKCU", key: "\\Missing" }).keyExists((e, exists) => {
        result = { e, exists };
      });

      expect(result.e).toBeNull();
      expect(result.exists).toBe(false);
    });

    it("reports keyExists=true when reg.exe succeeds", function () {
      execFileSpy.and.callFake((file, args, options, cb) => cb(null, "some output"));

      let result;
      new Registry({ hive: "HKLM", key: "\\SOFTWARE" }).keyExists((e, exists) => {
        result = { e, exists };
      });

      expect(result.exists).toBe(true);
    });

    it("deletes a key with DELETE /f", function () {
      execFileSpy.and.callFake((file, args, options, cb) => cb(null, ""));

      let called = false;
      new Registry({ hive: "HKCU", key: "\\Gone" }).destroy(() => {
        called = true;
      });

      expect(lastCall()[1]).toEqual(["DELETE", "HKCU\\Gone", "/f"]);
      expect(called).toBe(true);
    });
  });

  if (process.platform === "win32") {
    describe("against the real registry (win32)", function () {
      it("round-trips a literal command in an isolated registry key", async () => {
        const key = new Registry({
          hive: "HKCU",
          key: `\\Software\\LumineTests\\Registry-${process.pid}-${Date.now()}`,
        });
        const value = '"C:\\Program Files\\Lumine\\lumine.exe" "%1" & %V';
        try {
          await new Promise((resolve, reject) =>
            key.setString("", value, (error) => (error ? reject(error) : resolve())),
          );
          const item = await new Promise((resolve, reject) =>
            key.get("", (error, item) => (error ? reject(error) : resolve(item))),
          );
          expect(item.value).toBe(value);
        } finally {
          await new Promise((resolve, reject) =>
            key.destroy((error) => (error ? reject(error) : resolve())),
          );
        }
      });

      it("reports a well-known key as existing and a bogus one as missing", async function () {
        const exists = await new Promise((resolve, reject) =>
          new Registry({ hive: "HKLM", key: "\\SOFTWARE\\Microsoft" }).keyExists((err, e) =>
            err ? reject(err) : resolve(e),
          ),
        );
        expect(exists).toBe(true);

        const missing = await new Promise((resolve, reject) =>
          new Registry({ hive: "HKCU", key: "\\Software\\LumineNoSuchKey_ZZZ" }).keyExists(
            (err, e) => (err ? reject(err) : resolve(e)),
          ),
        );
        expect(missing).toBe(false);
      });
    });
  }
});
