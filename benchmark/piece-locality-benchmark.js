// PIECE_LOCALITY_CONFIG: {out}. Run from the chosen core in Electron Node mode.
const fs = require("node:fs");
const assert = require("node:assert/strict");
const PieceTree = require("../src/piece-tree");
const config = JSON.parse(process.env.PIECE_LOCALITY_CONFIG);
const offsets = [];
let length = 0;
const source = Array.from({ length: 120000 }, (_, row) => {
  offsets.push(length);
  const line = `row_${row} = "α😀 value_${row}";\r\n`;
  length += line.length;
  return line;
}).join("");
offsets.push(length);
const result = { versions: process.versions, rows: offsets.length, cases: [] };
for (const fragmented of [false, true]) {
  let tree = new PieceTree(source);
  if (fragmented)
    for (let i = 0; i < 2000; i++) {
      const index = offsets[(i * 59) % 120000] + 1;
      tree = tree.replace(index, index + 1, "z");
    }
  for (const kind of ["same-row", "viewport", "sequential", "random", "edit-read"]) {
    let seed = 481;
    const rows = Uint32Array.from({ length: kind === "edit-read" ? 5000 : 200000 }, (_, i) =>
      kind === "same-row" || kind === "edit-read"
        ? 60000
        : kind === "viewport"
          ? 60000 + (i % 120)
          : kind === "sequential"
            ? i % 120000
            : (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % 120000,
    );
    let expected = 0;
    for (const row of rows)
      expected += kind === "edit-read" ? offsets[row] * 2 + offsets[row + 1] + 1 : offsets[row];
    let checksum = 0,
      current = tree;
    const at = performance.now();
    for (const row of rows) {
      if (kind === "edit-read") {
        current = current.replace(offsets[row] + 1, offsets[row] + 2, "z");
        checksum +=
          current.lineStart(row) +
          current.lineStart(row + 1) +
          current.offsetAt({ row, column: 1 });
      } else checksum += current.lineStart(row);
    }
    const ms = performance.now() - at;
    assert.equal(checksum, expected);
    result.cases.push({ fragmented, kind, operations: rows.length, ms, checksum });
  }
}
fs.writeFileSync(config.out, JSON.stringify(result, null, 2));
