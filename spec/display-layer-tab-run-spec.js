const TextBuffer = require("../src/text-buffer");
const Point = require("../src/point");
const { isWrapBoundary } = require("../src/text-utils");

describe("DisplayLayer tab translation across text runs", () => {
  const buffers = [];

  afterEach(() => {
    while (buffers.length > 0) buffers.pop().destroy();
  });

  function buildLayer(text, params = {}, folds = []) {
    const buffer = new TextBuffer({ text });
    buffers.push(buffer);
    const layer = buffer.addDisplayLayer(params);
    for (const fold of folds) layer.foldBufferRange(fold);
    layer.populateSpatialIndexIfNeeded(Infinity, Infinity);
    return layer;
  }

  it("preserves tab stops and clipping before, inside and after distant tabs", () => {
    const layer = buildLayer(`${"x".repeat(128)}\t${"y".repeat(129)}\tEND`, {
      tabLength: 8,
    });
    expect(pointArray(layer.translateBufferPosition([0, 64]))).toEqual([0, 64]);
    expect(pointArray(layer.translateBufferPosition([0, 128]))).toEqual([0, 128]);
    expect(pointArray(layer.translateBufferPosition([0, 129]))).toEqual([0, 136]);
    expect(pointArray(layer.translateBufferPosition([0, 258]))).toEqual([0, 265]);
    expect(pointArray(layer.translateBufferPosition([0, 259]))).toEqual([0, 272]);
    expect(pointArray(layer.translateScreenPosition([0, 132]))).toEqual([0, 128]);
    expect(pointArray(layer.translateScreenPosition([0, 133]))).toEqual([0, 129]);
    expect(pointArray(layer.translateScreenPosition([0, 269]))).toEqual([0, 258]);
    expect(pointArray(layer.translateScreenPosition([0, 270]))).toEqual([0, 259]);
    expect(pointArray(layer.collapseHardTabs(Point(0, 133), layer.tabCounts[0]))).toEqual([0, 129]);
    expect(
      pointArray(layer.translateScreenPosition([0, 130], { clipDirection: "forward" })),
    ).toEqual([0, 129]);
    expect(
      pointArray(layer.translateScreenPosition([0, 135], { clipDirection: "backward" })),
    ).toEqual([0, 128]);
    expectMatchesScalar(layer);
  });

  it("stops at same-row folds and ignores tabs hidden by a fold", () => {
    const layer = buildLayer(
      `${"a".repeat(100)}\t${"b".repeat(120)}\t${"c".repeat(180)}\t${"d".repeat(180)}`,
      { tabLength: 8 },
      [
        [
          [0, 180],
          [0, 350],
        ],
      ],
    );
    expectMatchesScalar(layer);
  });

  it("resumes on a different buffer row after a fold", () => {
    const layer = buildLayer(
      [
        `${"a".repeat(96)}\t${"b".repeat(280)}`,
        "hidden\ttext",
        `${"c".repeat(170)}\t${"d".repeat(300)}\tend`,
      ].join("\n"),
      { tabLength: 4 },
      [
        [
          [0, 190],
          [2, 140],
        ],
      ],
    );
    expectMatchesScalar(layer);
  });

  it("preserves wrapped rows, leading whitespace and hanging indentation", () => {
    const layer = buildLayer(
      `        ${"alpha_beta ".repeat(18)}\t${"tail/word ".repeat(50)}\tend`,
      { tabLength: 8, softWrapColumn: 193, softWrapHangingIndent: 5, isWrapBoundary },
      [
        [
          [0, 250],
          [0, 300],
        ],
      ],
    );
    expect(layer.screenLineLengths.length).toBeGreaterThan(3);
    expectMatchesScalar(layer);
  });

  it("keeps paired-character clipping while skipping Unicode code units", () => {
    const layer = buildLayer(`${"漢😀e\u0301a".repeat(35)}\t${"é中💡".repeat(60)}\tend`, {
      tabLength: 8,
      softWrapColumn: 257,
      isWrapBoundary,
    });
    expect(
      pointArray(layer.translateBufferPosition([0, 2], { clipDirection: "backward" })),
    ).toEqual(pointArray(layer.translateBufferPosition([0, 1])));
    expect(pointArray(layer.translateBufferPosition([0, 2], { clipDirection: "forward" }))).toEqual(
      pointArray(layer.translateBufferPosition([0, 3])),
    );
    expectMatchesScalar(layer);
  });

  it("retains short and dense tab runs around the run-length threshold", () => {
    for (const length of [0, 1, 62, 63, 64, 65, 127, 128, 129]) {
      const layer = buildLayer(`${"a".repeat(length)}\t${"b\t".repeat(80)}${"c".repeat(200)}\t`, {
        tabLength: 4,
      });
      expectMatchesScalar(layer, `prefix length ${length}`);
    }
  });

  it("retains fractional targets, tab lengths and hanging indentation", () => {
    for (const params of [
      { tabLength: 4 },
      { tabLength: 2.5 },
      { tabLength: 4, softWrapColumn: 193, softWrapHangingIndent: 2.5 },
    ]) {
      const layer = buildLayer(`\t${"a".repeat(300)}\t${"b".repeat(300)}\t`, params);
      expectMatchesScalar(layer, JSON.stringify(params), true);
    }
  });

  it("recomputes translations after edits, resets and fold removal", () => {
    const layer = buildLayer(`${"a".repeat(130)}\t${"b".repeat(300)}\tend`, { tabLength: 8 });
    const fold = layer.foldBufferRange([
      [0, 200],
      [0, 260],
    ]);
    expectMatchesScalar(layer);
    layer.buffer.insert([0, 20], `${"x".repeat(90)}\t`);
    expectMatchesScalar(layer);
    layer.buffer.delete([
      [0, 40],
      [0, 120],
    ]);
    expectMatchesScalar(layer);
    layer.destroyFold(fold);
    layer.reset({ tabLength: 3, softWrapColumn: 257, softWrapHangingIndent: 3 });
    expectMatchesScalar(layer);
  });

  it("matches scalar translation across deterministic mixed layouts", () => {
    const random = randomGenerator(0x74ab1e);
    const units = ["a", "b", " ", "-", "/", "漢", "😀", "e\u0301"];
    for (let index = 0; index < 40; index++) {
      const rows = Array.from({ length: 3 }, () => {
        let line = "";
        for (let run = 0; run < 8; run++) {
          const unit = units[Math.floor(random() * units.length)];
          line += unit.repeat(1 + Math.floor(random() * 140));
          line += "\t";
        }
        return line;
      });
      const layer = buildLayer(
        rows.join("\n"),
        {
          tabLength: 1 + Math.floor(random() * 8),
          softWrapColumn: [Infinity, 129, 257, 513][index % 4],
          softWrapHangingIndent: index % 7,
          isWrapBoundary,
        },
        index % 2 === 0
          ? [
              [
                [0, 180],
                [2, 120],
              ],
            ]
          : [
              [
                [1, 100],
                [1, 220],
              ],
            ],
      );
      expectMatchesScalar(layer, `mixed layout ${index}`);
    }
  });
});

function expectMatchesScalar(layer, context = "", fractional = false) {
  layer.populateSpatialIndexIfNeeded(Infinity, Infinity);
  const bufferPositions = [];
  const screenPositions = [];
  for (let row = 0; row < layer.buffer.getLineCount(); row++) {
    const line = layer.buffer.lineForRow(row);
    for (const column of sampleColumns(line.length, fractional))
      bufferPositions.push([row, column]);
    for (let column = 0; column < line.length; column++) {
      if (line[column] === "\t" || (line.charCodeAt(column) > 127 && column % 31 === 0)) {
        for (const delta of [-1, 0, 1]) bufferPositions.push([row, column + delta]);
      }
    }
  }
  for (let row = 0; row < layer.screenLineLengths.length; row++) {
    for (const column of sampleColumns(layer.screenLineLengths[row], fractional)) {
      screenPositions.push([row, column]);
    }
  }
  for (const hunk of layer.spatialIndex.getChanges()) {
    for (const point of [hunk.oldStart, hunk.oldEnd]) bufferPositions.push(point);
    for (const point of [hunk.newStart, hunk.newEnd]) {
      for (const delta of [-1, 0, 1]) screenPositions.push([point.row, point.column + delta]);
    }
  }

  const snapshot = (reference) =>
    ["backward", "closest", "forward"].map((clipDirection) => {
      const buffer = bufferPositions.map((point) =>
        pointArray(
          reference
            ? scalarBufferTranslation(layer, point, clipDirection)
            : layer.translateBufferPosition(point, { clipDirection }),
        ),
      );
      return {
        buffer,
        screen: screenPositions.map((point) =>
          pointArray(
            reference
              ? scalarScreenTranslation(layer, point, clipDirection)
              : layer.translateScreenPosition(point, { clipDirection }),
          ),
        ),
        batch: reference
          ? buffer
          : layer.translateBufferPositions(bufferPositions, { clipDirection }).map(pointArray),
      };
    });
  expect(snapshot(false)).withContext(context).toEqual(snapshot(true));
}

// Compose the original scalar callers explicitly. The optimized callers may
// dispatch directly to a run scanner, so replacing their tab methods alone
// would no longer provide an independent reference.
function scalarBufferTranslation(layer, position, clipDirection) {
  position = layer.buffer.clipPosition(position);
  layer.populateSpatialIndexIfNeeded(position.row + 1, Infinity);
  const delta = layer.getClipColumnDelta(position, clipDirection);
  if (delta !== 0) position = Point(position.row, position.column + delta);
  let screen = layer.translateBufferPositionWithSpatialIndex(position, clipDirection);
  const tabCount = layer.tabCounts[screen.row];
  if (tabCount > 0) screen = scalarTabTranslation(layer, screen, tabCount, null, false);
  return Point.fromObject(screen);
}

function scalarScreenTranslation(layer, position, clipDirection) {
  position = Point.fromObject(position);
  Point.assertValid(position);
  layer.populateSpatialIndexIfNeeded(layer.buffer.getLineCount(), position.row + 1);
  position = layer.constrainScreenPosition(position, clipDirection);
  const tabCount = layer.tabCounts[position.row];
  if (tabCount > 0) position = scalarTabTranslation(layer, position, tabCount, clipDirection, true);
  const buffer = layer.translateScreenPositionWithSpatialIndex(position, clipDirection);
  const delta = layer.getClipColumnDelta(buffer, clipDirection);
  return delta !== 0 ? Point(buffer.row, buffer.column + delta) : Point.fromObject(buffer);
}

function sampleColumns(length, fractional) {
  const columns = [
    0,
    1,
    62,
    63,
    64,
    65,
    127,
    128,
    Math.floor(length / 2),
    length - 1,
    length,
    Infinity,
  ];
  if (fractional) columns.push(0.5, 63.5, 64.5, 128.5, Math.floor(length / 2) + 0.5);
  return columns;
}

// The original character-by-character mapping is the reference for run skipping.
// Keep its equality checks and clipping arithmetic, including fractional inputs.
function scalarTabTranslation(layer, target, tabCount, clipDirection, collapse) {
  const rowStart = Point(target.row, 0);
  const rangeEnd = collapse ? Point(target.row, layer.screenLineLengths[target.row]) : target;
  const hunks = layer.spatialIndex.getChangesInNewRange(rowStart, rangeEnd);
  let hunkIndex = 0;
  let unexpanded = 0;
  let expanded = 0;
  let { row, column } = layer.translateScreenPositionWithSpatialIndex(rowStart);
  let line = layer.buffer.lineForRow(row);
  while (tabCount > 0) {
    if ((collapse ? expanded : unexpanded) === target.column) break;
    const hunk = hunks[hunkIndex];
    if (hunk && hunk.oldStart.row === row && hunk.oldStart.column === column) {
      if (layer.isSoftWrapHunk(hunk)) {
        if (hunkIndex !== 0) throw new Error("Unexpected soft wrap hunk");
        unexpanded = collapse ? Math.min(target.column, hunk.newEnd.column) : hunk.newEnd.column;
        expanded = unexpanded;
      } else {
        ({ row, column } = hunk.oldEnd);
        line = layer.buffer.lineForRow(row);
        unexpanded++;
        expanded++;
      }
      hunkIndex++;
      continue;
    }
    if (line[column] === "\t") {
      const nextTabStop = collapse
        ? expanded + layer.tabLength - (expanded % layer.tabLength)
        : expanded + (layer.tabLength - (expanded % layer.tabLength));
      if (collapse && nextTabStop > target.column) {
        const afterTab =
          clipDirection === "forward" ||
          (clipDirection !== "backward" && target.column > Math.ceil((nextTabStop + expanded) / 2));
        return Point(target.row, unexpanded + (afterTab ? 1 : 0));
      }
      expanded = nextTabStop;
      tabCount--;
    } else {
      expanded++;
    }
    unexpanded++;
    column++;
  }
  const translated = collapse
    ? unexpanded + (target.column - expanded)
    : expanded + (target.column - unexpanded);
  return Point(target.row, translated);
}

function pointArray(point) {
  return [point.row, point.column];
}

function randomGenerator(seed) {
  let state = seed | 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}
