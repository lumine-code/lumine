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
for (const [language, ownership] of [
  ["ipython", "quoted"],
  ["ipython", "comment"],
  ["python", "root-policy"],
]) {
  for (const sizeKiB of [50, 500])
    for (const cursors of counts)
      definitions.push({
        id: `${language}-${sizeKiB}-${ownership}-chain-${cursors}`,
        language,
        sizeKiB,
        cursors,
        kind: "chain",
        ownership,
      });
}
// Keep these opt-in cases above the large-buffer parse coalescing threshold.
for (const [language, ownership] of [
  ["python", "fast"],
  ["ipython", "fast"],
  ["ipython", "quoted"],
]) {
  definitions.push({
    id: `${language}-1000${ownership === "fast" ? "" : `-${ownership}`}-chain-2`,
    language,
    sizeKiB: 1000,
    cursors: 2,
    kind: "chain",
    ownership,
  });
}

// Portable provider: the worker resolves this module in its own realm. Its
// deliberately opaque contract requires a parsed ownership proof even though
// its actual coverage remains the entire document.
function allRootRanges(source) {
  return [[[0, 0], source.positionAt(source.length)]];
}

function fixture(definition) {
  const { language, sizeKiB, cursors, kind } = definition;
  const ownership = definition.ownership ?? "fast";
  if (!new Set(["fast", "quoted", "comment", "root-policy"]).has(ownership))
    throw new RangeError("Unknown ownership fixture");
  if (
    (ownership !== "fast" && kind !== "chain") ||
    ((ownership === "quoted" || ownership === "comment") && language !== "ipython") ||
    (ownership === "root-policy" && language !== "python")
  )
    throw new RangeError("Ownership variant does not match its language and source kind");
  const target = [];
  for (let i = 0; i < 129; i++) {
    const n = String(i).padStart(3, "0");
    const body =
      ownership === "quoted"
        ? `print("public value_${n}")`
        : `work_${n}()${ownership === "comment" ? ` # public inline comment ${n}` : ""}`;
    target.push(
      kind === "noop"
        ? `result_${n} = (flag_${n}, ${i}, True)`
        : `${kind === "chain" && i > 0 ? "elif" : "if"} flag_${n}: ${body}`,
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
    rootRanges:
      ownership === "root-policy" ? { module: __filename, method: "allRootRanges" } : null,
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
      ownershipVariant: ownership,
      ownershipPath: ownership === "fast" ? "policy-projection" : "parsed-discovery",
      rootRangeProvider: ownership === "root-policy" ? "allRootRanges" : null,
      description:
        ownership === "quoted"
          ? "Dependent if/elif chain with quoted calls; the conservative IPython policy requires parsed ownership verification"
          : ownership === "comment"
            ? "Dependent if/elif chain with inline comments; the conservative IPython policy requires parsed ownership verification"
            : ownership === "root-policy"
              ? "Dependent if/elif chain under an opaque full-document root-range provider"
              : kind === "chain"
                ? "Dependent if/elif chain; raw split leaves later clauses orphaned until earlier prefixes materialize"
                : kind === "noop"
                  ? "Independent assignment EOLs; every suggested prefix equals the empty prefix"
                  : "Independent if headers; every selected body needs four spaces",
    },
  };
}

function offsetsAt(text, positions) {
  const starts = [0];
  for (let next = text.indexOf("\n"); next !== -1; next = text.indexOf("\n", next + 1))
    starts.push(next + 1);
  return positions.map(([row, column]) => {
    const start = starts[row];
    const end = row + 1 < starts.length ? starts[row + 1] - 1 : text.length;
    if (
      !Number.isSafeInteger(row) ||
      !Number.isSafeInteger(column) ||
      start == null ||
      column < 0 ||
      start + column > end
    )
      throw new RangeError("Burst cursor is outside its source row");
    return start + column;
  });
}

// One join per operation keeps construction proportional to source size plus
// edits. No editor, syntax query or input queue participates in this oracle.
function applyEdits(text, edits) {
  const pieces = [];
  let previousEnd = 0;
  for (const { start, end, inserted } of edits) {
    if (start < previousEnd || end < start || end > text.length)
      throw new RangeError("Burst edits must be ordered and disjoint");
    pieces.push(text.slice(previousEnd, start), inserted);
    previousEnd = end;
  }
  pieces.push(text.slice(previousEnd));
  return pieces.join("");
}

// Every cycle dispatches Enter, literal "xy", Backspace, with no intervening
// settlement. The retained "x" makes the final frame different from Enter's
// frame. Prior x rows remain in the same four-space suite (or a zero-space
// top-level noop fixture) on subsequent cycles.
function burstStates(input, cycles = 1) {
  if (!Number.isSafeInteger(cycles) || cycles < 1)
    throw new RangeError("Burst cycles must be a positive safe integer");
  const typingText = "xy";
  let text = input.source;
  let positions = input.points.map((point) => [...point]);
  const margins = input.expectedPositions.map((point) => point[1]);
  const state = (cycle, operation) => ({
    cycle,
    operation,
    text,
    positions: positions.map((point) => [...point]),
    hash: hash(text),
  });
  const initial = state(0, "initial");
  const states = [];
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const offsets = offsetsAt(text, positions);
    text = applyEdits(
      text,
      offsets.map((offset, index) => ({
        start: offset,
        end: offset,
        inserted: "\n" + " ".repeat(margins[index]),
      })),
    );
    positions = positions.map(([row], index) => [row + index + 1, margins[index]]);
    states.push(state(cycle, "enter"));
    const insertedOffsets = offsetsAt(text, positions);
    text = applyEdits(
      text,
      insertedOffsets.map((offset) => ({ start: offset, end: offset, inserted: typingText })),
    );
    positions = positions.map(([row, column]) => [row, column + typingText.length]);
    states.push(state(cycle, "text"));
    const backspaceOffsets = offsetsAt(text, positions);
    if (backspaceOffsets.some((offset) => text[offset - 1] !== "y"))
      throw new Error("Burst Backspace must remove the inserted ASCII y");
    text = applyEdits(
      text,
      backspaceOffsets.map((offset) => ({ start: offset - 1, end: offset, inserted: "" })),
    );
    positions = positions.map(([row, column]) => [row, column - 1]);
    states.push(state(cycle, "backspace"));
  }
  const undo = states.map((_, index) => states[states.length - index - 2] ?? initial);
  return {
    typingText,
    cycles,
    initial,
    states,
    final: states.at(-1),
    undo,
    redo: [...states],
    publications: states.length,
    undoGroupingInterval: 0,
  };
}

module.exports = { definitions, fixture, hash, allRootRanges, burstStates };
