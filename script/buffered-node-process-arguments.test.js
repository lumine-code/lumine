"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const BufferedNodeProcess = require("../src/buffered-node-process");

function controlledRuntime(applicable) {
  const filename = path.resolve(__dirname, "../src/buffered-node-process.js");
  const preload = path.resolve(__dirname, "../src/electron-rm-sync-compatibility.js");
  const module = { exports: {} };
  const environment = { PARENT_SETTING: "retained" };
  const require = (name) => {
    if (name === "./electron-rm-sync-compatibility") return { isApplicable: () => applicable };
    if (name === "./buffered-process")
      return class {
        constructor(options) {
          this.launch = options;
        }
      };
    throw new Error(`Unexpected dependency ${name}`);
  };
  require.resolve = (name) => {
    assert.equal(name, "./electron-rm-sync-compatibility");
    return preload;
  };
  const context = vm.createContext({
    module,
    require,
    process: { env: environment, execPath: process.execPath },
  });
  new vm.Script(fs.readFileSync(filename, "utf8"), { filename }).runInContext(context);
  return { Process: module.exports, preload, environment };
}

test("standalone Node receives independent empty argument arrays without environment changes", () => {
  const before = { ...process.env };
  const first = BufferedNodeProcess.getNodeExecArguments();
  const second = BufferedNodeProcess.getNodeExecArguments();
  assert.deepEqual(first, []);
  assert.notEqual(first, second);
  first.push("caller-only");
  assert.deepEqual(second, []);
  assert.deepEqual(BufferedNodeProcess.getNodeExecArguments(), []);
  assert.deepEqual({ ...process.env }, before);
});

for (const applicable of [false, true]) {
  test(`constructor preserves script arguments and runtime argument order (${applicable})`, () => {
    const { Process, preload, environment } = controlledRuntime(applicable);
    const first = Process.getNodeExecArguments();
    const second = Process.getNodeExecArguments();
    assert.notEqual(first, second);
    assert.deepEqual(Array.from(first), applicable ? ["--require", preload] : []);
    first.push("caller-only");
    const args = ["--stdio", "value with spaces", "--require", "script-owned-option"];
    const original = [...args];
    const command = path.resolve("server with spaces.cjs");
    const process = new Process({ command, args });
    assert.deepEqual(Array.from(process.launch.args), [
      "--no-deprecation",
      ...(applicable ? ["--require", preload] : []),
      command,
      ...original,
    ]);
    assert.deepEqual(args, original);
    assert.deepEqual(Array.from(second), applicable ? ["--require", preload] : []);
    assert.deepEqual(environment, { PARENT_SETTING: "retained" });
    assert.equal(environment.NODE_OPTIONS, undefined);
  });
}
