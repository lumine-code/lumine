"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { installSilently } = require("./install-silent");

const windows = { platform: "win32", env: { SystemRoot: "C:\\Windows" } };

for (const [status, message] of [
  [2, /Close Lumine/],
  [3, /elevated shell/],
  [1, /Unable to check/],
]) {
  test(`stops before invoking the installer when preflight exits with ${status}`, () => {
    const calls = [];
    assert.throws(
      () =>
        installSilently({
          ...windows,
          run(file) {
            calls.push(file);
            return { status };
          },
        }),
      message,
    );
    assert.deepEqual(calls, ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"]);
  });
}

test("runs the selected installer with the silent and closed-app options and checks its exit", (t) => {
  const installer = path.join(os.tmpdir(), `lumine-silent-${randomUUID()}.exe`);
  fs.writeFileSync(installer, "installer fixture");
  t.after(() => fs.unlinkSync(installer));
  const calls = [];
  const run = (file, args, options) => {
    calls.push({ file, args, options });
    return { status: file === installer ? 5 : 0 };
  };
  assert.throws(() => installSilently({ ...windows, installer, run }), /exited with code 5/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].file, installer);
  assert.deepEqual(calls[1].args, ["/S", "--require-closed"]);
  assert.equal(calls[1].options.windowsHide, true);
});

test("requires a built installer after successful preflight", () => {
  assert.throws(
    () =>
      installSilently({
        ...windows,
        installer: path.join(os.tmpdir(), `missing-${randomUUID()}.exe`),
        run: () => ({ status: 0 }),
      }),
    /Run npm run full first/,
  );
});
