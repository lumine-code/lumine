// Run under Electron's Node mode with SYMBOL_COORDINATE_CONFIG:
// {modulePath, documentWorkPath, out, count?}. This isolates coordinate work;
// post-edit-refresh-benchmark-spec.js measures the actual editor/package fleet.
const fs = require("node:fs");
const crypto = require("node:crypto");
const Point = require("../src/point");
const Range = require("../src/range");
const config = JSON.parse(process.env.SYMBOL_COORDINATE_CONFIG);
const track = require(config.modulePath);
const documentWork = require(config.documentWorkPath);
const count = config.count ?? 200000;
const summary = (values) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    max: sorted.at(-1),
    total: sorted.reduce((sum, value) => sum + value, 0),
  };
};
const make = (length, nested) =>
  Array.from({ length }, (_, row) => ({
    position: new Point(row, 3),
    range: new Range([row, 0], [nested && row % 128 === 0 ? length - 1 : row, 20]),
  }));
const change = (row, operation) => ({
  oldRange: new Range([row, 3], [operation === "delete-line" ? row + 1 : row, 3]),
  newRange: new Range(
    [row, 3],
    [operation === "enter" ? row + 1 : row, operation === "column" ? 4 : 3],
  ),
  oldText: operation === "delete-line" ? "\n   " : "",
  newText: operation === "enter" ? "\n   " : operation === "column" ? "x" : "",
});
async function prepare(symbols) {
  const start = performance.now();
  const slices = [];
  if (track.prepare) {
    let sliceStart = start;
    await documentWork.run(track.prepare(symbols), {
      yieldTask: async () => {
        slices.push(performance.now() - sliceStart);
        await new Promise((resolve) => setImmediate(resolve));
        sliceStart = performance.now();
      },
    });
    slices.push(performance.now() - sliceStart);
  }
  return { wall: performance.now() - start, slices: slices.length ? summary(slices) : null };
}
async function main() {
  // Warm call shapes without forcing GC or including warm-up in measurements.
  const warm = make(2048, false);
  await prepare(warm);
  for (let i = 0; i < 100; i++) track(warm, [change(1000, i % 2 ? "column" : "enter")]);
  const result = { versions: process.versions, count, cases: [] };
  for (const nested of [false, true]) {
    for (const operation of ["column", "enter", "delete-line", "bulk-column"]) {
      for (const position of operation === "bulk-column" ? ["whole"] : ["start", "middle", "end"]) {
        const symbols = make(count, nested);
        const preparation = await prepare(symbols);
        const row = position === "start" ? 0 : position === "middle" ? count / 2 : count - 100;
        const bulkCount = Math.min(2000, count);
        const changes =
          operation === "bulk-column"
            ? Array.from({ length: bulkCount }, (_, i) =>
                change(count - 1 - i * Math.floor(count / bulkCount), "column"),
              )
            : [change(row, operation)];
        const durations = [];
        for (let i = 0; i < 30; i++) {
          const at = performance.now();
          track(symbols, changes);
          durations.push(performance.now() - at);
        }
        const digest = crypto.createHash("sha256");
        for (const { position, range } of symbols)
          digest.update(
            `${position.row},${position.column};${range.start.row},${range.start.column};${range.end.row},${range.end.column}\n`,
          );
        result.cases.push({
          nested,
          operation,
          position,
          preparation,
          work: summary(durations),
          coordinatesHash: digest.digest("hex"),
        });
      }
    }
  }
  fs.writeFileSync(config.out, JSON.stringify(result, null, 2));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
