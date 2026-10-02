const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1];
}

const source = path.resolve(option("source", path.join(__dirname, "..")));
const baselineSource = path.resolve(option("baseline", source));
const TextBuffer = require(path.join(source, "src/text-buffer"));
const BaselineTextBuffer = require(path.join(baselineSource, "src/text-buffer"));
const samples = Number(option("samples", 20));
const warmups = Number(option("warmups", 20));
const repetitions = Number(option("repetitions", 40));
const text = "alpha beta\r\n\n😀\tcoffee\n" + "line0123456789\n".repeat(1000);
const cases = [
  { id: "empty/interior", start: 5, end: 5 },
  { id: "empty/eol", start: 14, end: 14 },
  { id: "same-row/delete", start: 4, end: 8 },
  { id: "same-row/clipped", start: -1, end: 100 },
  { id: "multiline/control", start: 4, end: 8, multiline: true },
  { id: "edit/insert-delete", edit: true },
];

function median(values) {
  return values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

function makeRanges(buffer, entry) {
  const { Range } = buffer.constructor;
  return Array.from(
    { length: 128 },
    (_, index) =>
      new Range(
        [index + 3, entry.start],
        [index + 3 + Number(Boolean(entry.multiline)), entry.end],
      ),
  );
}

function run(buffer, ranges) {
  let checksum = 0;
  for (let repeat = 0; repeat < repetitions; repeat++) {
    for (const range of ranges) {
      const result = buffer.clipRange(range);
      checksum += result.start.row + result.start.column + result.end.row + result.end.column;
    }
  }
  return checksum;
}

function runEdits(buffer) {
  let checksum = 0;
  for (let repeat = 0; repeat < repetitions; repeat++) {
    buffer.transact(() => {
      for (let index = 0; index < 128; index++) {
        const row = index + 3;
        const inserted = buffer.insert([row, 5], "x");
        checksum += inserted.end.column;
        buffer.delete(inserted);
      }
    });
    buffer.clearUndoStack();
  }
  return checksum;
}

function nativeCallCounts(buffer, range) {
  const counts = {};
  const methods = ["getLastRow", "lineLengthForRow"];
  try {
    for (const name of methods) {
      const original = buffer[name];
      counts[name] = 0;
      buffer[name] = function (...args) {
        counts[name]++;
        return original.apply(this, args);
      };
    }
    buffer.clipRange(range);
  } finally {
    for (const name of methods) delete buffer[name];
  }
  return counts;
}

function checkParity(before, after) {
  const coordinates = [
    -Infinity,
    -100,
    -1,
    -0.1,
    0,
    0.1,
    1,
    1.9,
    2,
    3,
    9,
    10,
    14,
    1002,
    1003,
    Infinity,
    NaN,
    null,
    "1",
    {},
  ];
  function outcome(buffer, coordinates) {
    const range = new buffer.constructor.Range(coordinates[0], coordinates[1]);
    try {
      const result = buffer.clipRange(range);
      return {
        value: result.serialize(),
        sameRange: result === range,
        sameStart: result.start === range.start,
        sameEnd: result.end === range.end,
        aliased: result.start === result.end,
      };
    } catch (error) {
      return { error: error.message, type: error.constructor.name };
    }
  }
  let checks = 0;
  for (const row of coordinates) {
    for (const startColumn of coordinates) {
      for (const endColumn of coordinates) {
        const range = [
          [row, startColumn],
          [row, endColumn],
        ];
        assert.deepEqual(outcome(after, range), outcome(before, range));
        checks++;
      }
    }
  }
  for (const startRow of coordinates) {
    for (const endRow of coordinates) {
      const range = [
        [startRow, 100],
        [endRow, -1],
      ];
      assert.deepEqual(outcome(after, range), outcome(before, range));
      checks++;
    }
  }
  return checks;
}

const before = new BaselineTextBuffer(text);
const after = new TextBuffer(text);
const results = [];
let parityChecks;
try {
  parityChecks = checkParity(before, after);
  for (const entry of cases) {
    if (option("case") && option("case") !== entry.id) continue;
    const beforeRanges = entry.edit ? null : makeRanges(before, entry);
    const afterRanges = entry.edit ? null : makeRanges(after, entry);
    const execute = entry.edit ? runEdits : run;
    const expected = execute(before, beforeRanges);
    assert.equal(execute(after, afterRanges), expected);
    const beforeTimes = [];
    const afterTimes = [];
    for (let sample = -warmups; sample < samples; sample++) {
      const variants = [
        [before, beforeRanges, beforeTimes],
        [after, afterRanges, afterTimes],
      ];
      if (sample % 2) variants.reverse();
      for (const [buffer, ranges, times] of variants) {
        const start = performance.now();
        assert.equal(execute(buffer, ranges), expected);
        if (sample >= 0) times.push(performance.now() - start);
      }
    }
    assert.equal(after.getText(), before.getText());
    results.push({
      id: entry.id,
      operationsPerSample: repetitions * 128 * (entry.edit ? 2 : 1),
      baselineMs: median(beforeTimes),
      candidateMs: median(afterTimes),
      baselineCalls: entry.edit ? null : nativeCallCounts(before, beforeRanges[0]),
      candidateCalls: entry.edit ? null : nativeCallCounts(after, afterRanges[0]),
      beforeTimes,
      afterTimes,
      checksum: expected,
    });
  }
} finally {
  before.destroy();
  after.destroy();
}

const report = {
  node: process.version,
  platform: process.platform,
  cpu: os.cpus()[0].model,
  source,
  baselineSource,
  parityChecks,
  samples,
  warmups,
  results,
};
if (option("output"))
  fs.writeFileSync(path.resolve(option("output")), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
