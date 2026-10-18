const { test } = require("node:test");
const assert = require("node:assert/strict");
const { grammarExportName } = require("../../src/tree-sitter-wasm");

const header = [0, 97, 115, 109, 1, 0, 0, 0];
function uint(value) {
  const bytes = [];
  do {
    const byte = value & 127;
    value >>>= 7;
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return bytes;
}
function section(id, bytes) {
  return [id, ...uint(bytes.length), ...bytes];
}
function exports(names) {
  return section(7, [
    names.length,
    ...names.flatMap(([name, kind = 0]) => {
      const bytes = [...Buffer.from(name)];
      return [...uint(bytes.length), ...bytes, kind, 0];
    }),
  ]);
}

test("discovers grammar function exports without compiling the module", () => {
  const bytes = Buffer.from([
    ...header,
    ...section(0, new Array(256).fill(0)),
    ...exports([
      ["memory", 2],
      ["tree_sitter_python"],
      ["tree_sitter_python_external_scanner_create"],
    ]),
  ]);
  assert.equal(grammarExportName(bytes), "python");
  assert.equal(grammarExportName(new Uint8Array(bytes)), "python");
});

test("requires exactly one grammar function", () => {
  for (const names of [
    [],
    [["tree_sitter_python", 2]],
    [["tree_sitter_python"], ["tree_sitter_json"]],
  ]) {
    assert.throws(
      () => grammarExportName(Buffer.from([...header, ...exports(names)])),
      /exactly one Tree-sitter grammar/,
    );
  }
  assert.throws(() => grammarExportName(Buffer.from(header)), /no Tree-sitter grammar/);
});

test("rejects invalid headers, section lengths and truncated export records", () => {
  const valid = Buffer.from([...header, ...exports([["tree_sitter_python"]])]);
  for (let end = 0; end < valid.length; end++) {
    assert.throws(() => grammarExportName(valid.subarray(0, end)));
  }
  for (const bytes of [
    [...header, 7, 255, 255, 255, 255, 16],
    [...header, ...section(7, [0, 0])],
    [...header, ...section(7, [1, 255])],
  ]) {
    assert.throws(() => grammarExportName(Buffer.from(bytes)), RangeError);
  }
});
