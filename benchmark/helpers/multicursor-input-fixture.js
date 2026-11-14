const crypto = require("node:crypto");
const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");
const counts = [1, 2, 8, 32, 127, 128, 129];
const definitions = [];
for (const language of ["python", "ipython"]) {
  for (const sizeKiB of [50, 500])
    for (const cursors of counts)
      definitions.push({
        id: `${language}-${sizeKiB}-chain-${cursors}`,
        language,
        sizeKiB,
        cursors,
        kind: "chain",
      });
  for (const kind of ["noop", "independent"])
    definitions.push({
      id: `${language}-500-${kind}-128`,
      language,
      sizeKiB: 500,
      cursors: 128,
      kind,
    });
}
function fixture(definition) {
  const { language, sizeKiB, cursors, kind } = definition;
  const target = [];
  for (let i = 0; i < 129; i++) {
    const n = String(i).padStart(3, "0");
    target.push(
      kind === "noop"
        ? `result_${n} = (flag_${n}, ${i}, True)`
        : `${kind === "chain" && i > 0 ? "elif" : "if"} flag_${n}: work_${n}()`,
    );
  }
  const prefix = language === "ipython" ? "# %% public synthetic input benchmark\n" : "";
  const pad = [];
  let size = prefix.length + target.join("\n").length + 2;
  while (size < sizeKiB * 1024) {
    const i = pad.length;
    const line = `padding_${String(i).padStart(5, "0")} = ("public synthetic padding record", ${i}, True, None)`;
    pad.push(line);
    size += line.length + 1;
  }
  const half = Math.floor(pad.length / 2);
  const lines = [
    ...(prefix ? [prefix.trimEnd()] : []),
    ...pad.slice(0, half),
    ...target,
    ...pad.slice(half),
  ];
  const firstRow = (prefix ? 1 : 0) + half;
  const chosen =
    cursors === 1
      ? [0]
      : Array.from({ length: cursors }, (_, i) => Math.floor((i * 128) / (cursors - 1)));
  const points = chosen.map((i) => [
    firstRow + i,
    kind === "noop" ? target[i].length : target[i].indexOf(": ") + 2,
  ]);
  const source = lines.join("\n") + "\n";
  const offsets = [];
  let rowOffset = 0;
  let pointIndex = 0;
  for (let row = 0; row < lines.length; row++) {
    if (points[pointIndex]?.[0] === row) {
      offsets.push(rowOffset + points[pointIndex][1]);
      pointIndex++;
    }
    rowOffset += lines[row].length + 1;
  }
  const insertion = kind === "noop" ? "\n" : "\n    ";
  let expected = source;
  for (const offset of [...offsets].reverse())
    expected = expected.slice(0, offset) + insertion + expected.slice(offset);
  const expectedPositions = points.map((point, i) => [point[0] + i + 1, kind === "noop" ? 0 : 4]);
  return {
    ...definition,
    source,
    points,
    expected,
    expectedPositions,
    metadata: {
      sourceBytes: Buffer.byteLength(source),
      sourceUnits: source.length,
      sourceHash: hash(source),
      outputHash: hash(expected),
      targetFirstRow: firstRow,
      targetBranches: 129,
      selectedBranches: chosen,
      paddingRows: pad.length,
      cellMarker: language === "ipython" ? "# %% public synthetic input benchmark" : null,
      lineEnding: "LF",
      grammarScope: language === "python" ? "source.python" : "source.python.ipy",
      description:
        kind === "chain"
          ? "Dependent if/elif chain; raw split leaves later clauses orphaned until earlier prefixes materialize"
          : kind === "noop"
            ? "Independent assignment EOLs; every suggested prefix equals the empty prefix"
            : "Independent if headers; every selected body needs four spaces",
    },
  };
}
module.exports = { definitions, fixture, hash };
