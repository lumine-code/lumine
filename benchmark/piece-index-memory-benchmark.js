// PIECE_MEMORY_CONFIG: {out}. Count actual index-array payload allocations.
// Electron's embedded Node reports zero for memoryUsage().arrayBuffers, so
// this intentionally measures byteLength rather than process RSS or heap size.
const fs = require("node:fs");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const config = JSON.parse(process.env.PIECE_MEMORY_CONFIG);
let allocations;
const instrument = (Type) =>
  new Proxy(Type, {
    get(target, key) {
      if (key !== "from") return Reflect.get(target, key);
      return (values) => {
        const array = Type.from(values);
        allocations[Type.name] += array.byteLength;
        return array;
      };
    },
  });
const isolated = { exports: {} };
vm.runInNewContext(fs.readFileSync(require.resolve("../src/piece-tree"), "utf8"), {
  module: isolated,
  Uint16Array: instrument(Uint16Array),
  Uint32Array: instrument(Uint32Array),
});
const PieceTree = isolated.exports;
const cases = [];
for (const [kind, source, expectedLines] of [
  ["source-lf", "function work() { return 42; }\n".repeat(100000), 100001],
  ["crlf", "row\r\n".repeat(500000), 500001],
  ["astral-crlf", "😀\r\n".repeat(500000), 500001],
  ["dense-lf", "\n".repeat(2 * 1024 * 1024), 2 * 1024 * 1024 + 1],
  ["long-line", "x".repeat(2 * 1024 * 1024), 1],
]) {
  allocations = { Uint16Array: 0, Uint32Array: 0 };
  const tree = new PieceTree(source);
  const indexBytes = allocations.Uint16Array + allocations.Uint32Array;
  assert.equal(tree.lineCount, expectedLines);
  assert.equal(tree.toString(), source);
  assert.equal(tree.lineStart(expectedLines - 1), source.lastIndexOf("\n") + 1);
  cases.push({ kind, units: source.length, lines: expectedLines, indexBytes, allocations });
}
fs.writeFileSync(config.out, JSON.stringify({ cases, versions: process.versions }, null, 2));
