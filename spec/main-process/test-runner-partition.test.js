const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { partitionSpecFiles, runNodeSpecs } = require("./jasmine-test-runner");

test("main-process runners follow actual imports, not examples in comments or strings", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-spec-partition-"));
  const contents = [
    'const { test } = require("node:test"); test("node", () => {});',
    'const test = require("node:test"); test("node", () => {});',
    'import {test} from "node:test"; test("node", () => {});',
    '// require("node:test")\nconst example = \'require("node:test")\'; describe("jasmine", () => {});',
  ];
  const files = contents.map((content, index) => {
    const file = path.join(directory, `${index}.test.js`);
    fs.writeFileSync(file, content);
    return file;
  });
  try {
    assert.deepEqual(partitionSpecFiles(files), {
      nodeFiles: files.slice(0, 3),
      jasmineFiles: files.slice(3),
    });
  } finally {
    for (const file of files) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
});

test("a failing Node suite cannot be hidden by a successful Jasmine result", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-spec-exit-"));
  const file = path.join(directory, "probe.test.js");
  try {
    fs.writeFileSync(file, 'require("node:test")("passes", () => {});');
    assert.equal(await runNodeSpecs([file], { stdio: "ignore" }), 0);
    fs.writeFileSync(
      file,
      'require("node:test")("fails", () => { throw new Error("expected fixture failure"); });',
    );
    assert.notEqual(await runNodeSpecs([file], { stdio: "ignore" }), 0);
    assert.equal(await runNodeSpecs([]), 0);
  } finally {
    fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
});
