"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const vm = require("node:vm");
const callbackRm = fs.rm;
const promiseRm = fs.promises.rm;
const originalRmSync = fs.rmSync;
const {
  createSafeRmSync,
  install,
  isApplicable,
} = require("../src/electron-rm-sync-compatibility");
const safeRmSync = createSafeRmSync();

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-safe-rm-contract-"));
  t.after(() => {
    assert.equal(fs.realpathSync(path.dirname(root)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("lumine-safe-rm-contract-"));
    // All entries here were created by this test. Never clean a user profile
    // or point a fixture link outside this newly-created synthetic directory.
    safeRmSync(root, { recursive: true, force: true });
  });
  return root;
}

function fakeRepository(root) {
  const repo = path.join(root, "synthetic-repository");
  fs.mkdirSync(path.join(repo, ".git", "objects"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".git", "refs", "heads"), { recursive: true });
  const files = [
    ".git/HEAD",
    ".git/config",
    ".git/index",
    ".git/objects/object",
    ".git/refs/heads/master",
    "source.js",
  ];
  for (const file of files) fs.writeFileSync(path.join(repo, file), `synthetic ${file}\n`);
  return { repo, files };
}

test("removes nested junctions and cycles without visiting their targets", (t) => {
  const root = fixture(t),
    { repo, files } = fakeRepository(root);
  const profile = path.join(root, "synthetic-profile"),
    packages = path.join(profile, "packages");
  fs.mkdirSync(packages, { recursive: true });
  const link = path.join(packages, "synthetic-package");
  fs.symlinkSync(repo, link, process.platform === "win32" ? "junction" : "dir");
  fs.symlinkSync(
    profile,
    path.join(profile, "cycle"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal(safeRmSync(profile, { recursive: true, force: true }), undefined);
  assert.equal(fs.existsSync(profile), false);
  for (const file of files)
    assert.equal(fs.readFileSync(path.join(repo, file), "utf8"), `synthetic ${file}\n`);
});

test("removes a final junction, including a trailing separator, while retaining read-only canaries", (t) => {
  const root = fixture(t),
    { repo, files } = fakeRepository(root);
  const canary = path.join(repo, ".git", "objects", "object");
  fs.chmodSync(canary, 0o444);
  for (const trailing of [false, true]) {
    const link = path.join(root, `link-${trailing}`);
    fs.symlinkSync(repo, link, process.platform === "win32" ? "junction" : "dir");
    safeRmSync(link + (trailing ? path.sep : ""), { recursive: true, force: true });
    assert.equal(fs.existsSync(link), false);
    for (const file of files) assert.ok(fs.existsSync(path.join(repo, file)), file);
    assert.equal(fs.statSync(canary).mode & 0o222, 0);
  }
});

test("removes dangling directory links without canonicalizing their missing targets", (t) => {
  const root = fixture(t),
    link = path.join(root, "dangling");
  fs.symlinkSync(
    path.join(root, "not-created"),
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  safeRmSync(link, { recursive: true });
  assert.throws(() => fs.lstatSync(link), { code: "ENOENT" });
});

test("does not traverse a final link when lstat treats its trailing separator as a directory", (t) => {
  const root = fixture(t),
    target = path.join(root, "mock-link"),
    unlinked = [];
  const filesystem = {
    lstatSync(entry) {
      const trailing = String(entry).endsWith(path.sep);
      return { isDirectory: () => trailing, isSymbolicLink: () => !trailing };
    },
    unlinkSync(entry) {
      unlinked.push(entry);
    },
    readdirSync() {
      assert.fail("A trailing separator must not turn a link into a traversal");
    },
  };
  const remove = createSafeRmSync({ fs: filesystem });
  remove(target + path.sep, { recursive: true });
  remove(Buffer.from(target + path.sep), { recursive: true });
  assert.equal(unlinked[0], target);
  assert.deepEqual(unlinked[1], Buffer.from(target));
});

test("supports Buffer and file URL paths for ordinary files and recursive directories", (t) => {
  const root = fixture(t);
  for (const [name, convert] of [
    ["buffer", (value) => Buffer.from(value)],
    ["url", pathToFileURL],
  ]) {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, "nested"), { recursive: true });
    fs.writeFileSync(path.join(dir, "nested", "child.txt"), "synthetic");
    safeRmSync(convert(dir), { recursive: true });
    assert.equal(fs.existsSync(dir), false);
    const file = path.join(root, `${name}.txt`);
    fs.writeFileSync(file, "synthetic");
    safeRmSync(convert(file));
    assert.equal(fs.existsSync(file), false);
  }
});

test("preserves force and non-recursive directory errors", (t) => {
  const root = fixture(t),
    missing = path.join(root, "missing"),
    directory = path.join(root, "directory");
  fs.mkdirSync(directory);
  assert.throws(() => safeRmSync(missing), { code: "ENOENT", syscall: "lstat" });
  assert.equal(safeRmSync(missing, { force: true }), undefined);
  for (const options of [undefined, {}, { force: true }]) {
    assert.throws(
      () => safeRmSync(directory, options),
      (error) => {
        assert.equal(error.name, "SystemError");
        assert.equal(error.code, "ERR_FS_EISDIR");
        assert.equal(error.path, directory);
        assert.equal(error.syscall, "rm");
        assert.equal(error.info.code, "EISDIR");
        return true;
      },
    );
  }
  for (const input of [directory, Buffer.from(directory), pathToFileURL(directory)]) {
    assert.throws(
      () => safeRmSync(input),
      (error) => {
        assert.equal(error.path, String(input));
        assert.equal(error.info.path, input);
        assert.ok(error.message.endsWith(String(input)));
        return error.code === "ERR_FS_EISDIR";
      },
    );
  }
  assert.ok(fs.existsSync(directory));
});

test("keeps drive-relative recursion under the validated drive current directory", () => {
  // No real drive-relative filesystem operation is performed by this test.
  const directory = "C:\\synthetic\\drive-cwd";
  for (const value of ["C:", "C:.", "C:sub\\..", Buffer.from("C:")]) {
    const calls = [],
      removed = new Set();
    const text = (value) => (Buffer.isBuffer(value) ? value.toString("utf8") : value);
    const assertInside = (value) => {
      const actual = text(value);
      assert.ok(actual === directory || actual.startsWith(directory + "\\"), actual);
      return actual;
    };
    const filesystem = {
      lstatSync(entry) {
        if (entry === value) return { isSymbolicLink: () => false, isDirectory: () => true };
        const actual = assertInside(entry);
        calls.push(["lstat", actual]);
        return { isSymbolicLink: () => false, isDirectory: () => actual === directory };
      },
      readdirSync(entry, options) {
        assert.equal(assertInside(entry), directory);
        calls.push(["readdir", directory]);
        return options.encoding === "buffer" ? [Buffer.from("child.txt")] : ["child.txt"];
      },
      unlinkSync(entry) {
        removed.add(assertInside(entry));
        calls.push(["unlink", text(entry)]);
      },
      rmdirSync(entry) {
        assert.equal(assertInside(entry), directory);
        removed.add(directory);
      },
      rmSync() {
        assert.fail("Never invoke the native recursive binding");
      },
    };
    const remove = createSafeRmSync({
      fs: filesystem,
      platform: "win32",
      resolvePath: (entry) => path.win32.resolve(directory, entry),
    });
    remove(value, { recursive: true });
    assert.deepEqual([...removed], [directory + "\\child.txt", directory]);
    assert.ok(calls.length > 0);
  }
});

test("accepts Node file URLs in a renderer realm with a different global URL constructor", (t) => {
  const target = path.join(fixture(t), "renderer-url.txt");
  fs.writeFileSync(target, "synthetic");
  const filename = require.resolve("../src/electron-rm-sync-compatibility");
  const context = { require, process, Buffer, module: { exports: {} }, URL: class RendererURL {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), context, { filename });
  context.module.exports.createSafeRmSync()(pathToFileURL(target));
  assert.equal(fs.existsSync(target), false);
});

test("validates every rm option even when recursive is false", (t) => {
  const root = fixture(t),
    target = path.join(root, "missing");
  const bad = [
    [null, "ERR_INVALID_ARG_TYPE"],
    [1, "ERR_INVALID_ARG_TYPE"],
    [[], "ERR_INVALID_ARG_TYPE"],
    [{ force: undefined }, "ERR_INVALID_ARG_TYPE"],
    [{ recursive: 1 }, "ERR_INVALID_ARG_TYPE"],
    [{ maxRetries: "1" }, "ERR_INVALID_ARG_TYPE"],
    [{ maxRetries: -1 }, "ERR_OUT_OF_RANGE"],
    [{ maxRetries: 1.5 }, "ERR_OUT_OF_RANGE"],
    [{ maxRetries: 4294967296 }, "ERR_OUT_OF_RANGE"],
    [{ retryDelay: undefined }, "ERR_INVALID_ARG_TYPE"],
    [{ retryDelay: -1 }, "ERR_OUT_OF_RANGE"],
    [{ retryDelay: 1.5 }, "ERR_OUT_OF_RANGE"],
    [{ retryDelay: 2147483648 }, "ERR_OUT_OF_RANGE"],
  ];
  for (const [options, code] of bad) assert.throws(() => safeRmSync(target, options), { code });
  assert.throws(() => safeRmSync(target, Object.create({ force: true })), { code: "ENOENT" });
  assert.throws(() => safeRmSync(null, { force: true }), { code: "ERR_INVALID_ARG_TYPE" });
  assert.throws(() => safeRmSync("synthetic\0path", { force: true }), {
    code: "ERR_INVALID_ARG_VALUE",
  });
});

function mockFile(root, overrides = {}) {
  return {
    lstatSync() {
      return { mode: 0o666, isSymbolicLink: () => false, isDirectory: () => false };
    },
    unlinkSync() {},
    rmdirSync() {
      assert.fail("A regular file must not use rmdir");
    },
    rmSync() {
      assert.fail("The compatibility walker must never delegate native rmSync");
    },
    chmodSync() {
      assert.fail("A writable file needs no permission repair");
    },
    ...overrides,
  };
}

test("retries documented transient errors with linear delays only in recursive mode", (t) => {
  const target = path.join(fixture(t), "mock-file");
  for (const code of ["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]) {
    let calls = 0;
    const delays = [];
    const filesystem = mockFile(target, {
      unlinkSync() {
        if (++calls <= 2) throw Object.assign(new Error(code), { code });
      },
    });
    const remove = createSafeRmSync({
      fs: filesystem,
      platform: "win32",
      sleep: (delay) => delays.push(delay),
    });
    remove(target, { recursive: true, maxRetries: 2, retryDelay: 7 });
    assert.equal(calls, 3);
    assert.deepEqual(delays, [7, 14]);
    calls = 0;
    delays.length = 0;
    assert.throws(() => remove(target, { maxRetries: 4, retryDelay: 7 }), { code });
    assert.equal(calls, 1);
    assert.deepEqual(delays, []);
  }
});

test("repairs read-only ordinary entries once without changing linked targets", (t) => {
  const target = path.join(fixture(t), "mock-file");
  let writable = false,
    changes = 0;
  const filesystem = mockFile(target, {
    lstatSync() {
      return {
        mode: writable ? 0o644 : 0o444,
        isSymbolicLink: () => false,
        isDirectory: () => false,
      };
    },
    unlinkSync() {
      if (!writable) throw Object.assign(new Error("readonly"), { code: "EPERM" });
    },
    chmodSync(_path, mode) {
      changes++;
      assert.equal(mode, 0o644);
      writable = true;
    },
  });
  createSafeRmSync({ fs: filesystem, platform: "win32" })(target);
  assert.equal(changes, 1);
  let removals = 0;
  const linkFs = mockFile(target, {
    lstatSync() {
      return { mode: 0o444, isSymbolicLink: () => true, isDirectory: () => false };
    },
    unlinkSync() {
      throw Object.assign(new Error("junction"), { code: "EPERM" });
    },
    rmdirSync() {
      removals++;
    },
    chmodSync() {
      assert.fail("Never chmod a symlink target");
    },
  });
  createSafeRmSync({ fs: linkFs, platform: "win32" })(target, { recursive: true });
  assert.equal(removals, 1);
});

test("bounds permission-repair attempts if a filesystem ignores chmod", (t) => {
  const target = path.join(fixture(t), "mock-file");
  let calls = 0,
    changes = 0;
  const filesystem = mockFile(target, {
    lstatSync() {
      return { mode: 0o444, isSymbolicLink: () => false, isDirectory: () => false };
    },
    unlinkSync() {
      calls++;
      throw Object.assign(new Error("locked"), { code: "EPERM" });
    },
    chmodSync() {
      changes++;
    },
  });
  assert.throws(
    () =>
      createSafeRmSync({ fs: filesystem, platform: "win32", sleep() {} })(target, {
        recursive: true,
        maxRetries: 2,
      }),
    { code: "EPERM" },
  );
  assert.equal(changes, 1);
  assert.equal(calls, 4);
});

test("leaves callbacks, promises and standalone Node unchanged", () => {
  assert.equal(fs.rm, callbackRm);
  assert.equal(fs.promises.rm, promiseRm);
  if (!process.versions.electron) {
    assert.equal(install(), false);
    assert.equal(fs.rmSync, originalRmSync);
  }
  assert.equal(isApplicable({ platform: "win32", electron: "45.0.0" }), true);
  assert.equal(isApplicable({ platform: "win32", electron: "44.0.0" }), true);
  assert.equal(isApplicable({ platform: "linux", electron: "45.0.0" }), false);
  assert.equal(isApplicable({ platform: "win32", electron: "" }), false);
});
