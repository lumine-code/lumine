const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}

const source = path.resolve(option("source", path.join(__dirname, "..")));
const TextBuffer = require(path.join(source, "src", "text-buffer"));
const samples = Number(option("samples", 15));
const warmups = Number(option("warmups", 5));
const denseText = "alpha beta gamma delta\n";
const largeText = denseText.repeat(25000);
const cases = [
  { id: "first-match/small", text: denseText.repeat(32), regex: /beta/, repeats: 100 },
  { id: "first-match/large-dense", text: largeText, regex: /beta/, repeats: 5 },
  { id: "first-match/every-character", text: largeText, regex: /./, repeats: 1 },
  { id: "first-match/case-insensitive", text: largeText, regex: /^ALPHA/im, repeats: 5 },
  {
    id: "first-match/near-end",
    text: `${largeText}needle`,
    regex: /needle/,
    repeats: 20,
  },
  { id: "first-match/absent", text: largeText, regex: /needle/, repeats: 20 },
  {
    id: "all-matches/control",
    text: denseText.repeat(1000),
    regex: /beta/g,
    repeats: 5,
  },
  {
    id: "last-match/control",
    text: denseText.repeat(1000),
    regex: /beta/,
    reverse: true,
    repeats: 5,
  },
];

function runCase(testCase) {
  const repeats = Number(option("repeats", testCase.repeats));
  const buffer = new TextBuffer(testCase.text);
  const range = buffer.getRange();
  const scan = testCase.reverse ? "backwardsScanInRange" : "scanInRange";
  const expectedRanges = buffer.findAllInRangeSync(testCase.regex, range);
  const expectedRange = testCase.reverse ? expectedRanges.at(-1) : expectedRanges[0];
  const expectedCount = testCase.regex.global ? expectedRanges.length : expectedRange ? 1 : 0;
  const expectedChecksum = testCase.regex.global
    ? expectedRanges.reduce((sum, match) => sum + match.start.row + match.start.column, 0)
    : expectedRange
      ? expectedRange.start.row + expectedRange.start.column
      : 0;
  let count = 0;
  let checksum = 0;
  const callback = ({ range: matchRange }) => {
    count++;
    checksum += matchRange.start.row + matchRange.start.column;
  };
  const samplesMs = [];
  try {
    for (let sample = -warmups; sample < samples; sample++) {
      count = 0;
      checksum = 0;
      const start = performance.now();
      for (let repeat = 0; repeat < repeats; repeat++) {
        buffer[scan](testCase.regex, range, callback);
      }
      const duration = (performance.now() - start) / repeats;
      assert.equal(count, expectedCount * repeats, testCase.id);
      assert.equal(checksum, expectedChecksum * repeats, testCase.id);
      if (sample >= 0) samplesMs.push(duration);
    }
    const sorted = samplesMs.slice().sort((a, b) => a - b);
    return {
      id: testCase.id,
      textLength: testCase.text.length,
      matchCount: expectedCount,
      checksum: expectedChecksum,
      repeats,
      medianMs: sorted[Math.floor(sorted.length / 2)],
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      samplesMs,
    };
  } finally {
    buffer.destroy();
  }
}

const report = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  cpu: os.cpus()[0].model,
  source,
  samples,
  warmups,
  results: cases
    .filter((testCase) => !option("case") || testCase.id === option("case"))
    .map(runCase),
};
const output = option("output");
if (output) fs.writeFileSync(path.resolve(output), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
