"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const directory = path.resolve(__dirname, "../../.dev/fuzzy-performance-review-20261023");
const read = (file) => JSON.parse(fs.readFileSync(path.join(directory, file)));
const runs = read("runs.json");
const corpus = read("corpus.json");
const groups = new Map();
const stats = (samples) => {
  const ordered = samples.slice().sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return {
    median: ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2,
    p95: ordered[Math.ceil(ordered.length * 0.95) - 1],
    samples,
  };
};
let completeOrderedComparisons = 0;
for (const run of runs) {
  assert.equal(run.driverHash, runs[0].driverHash, "Driver changed during the balanced run");
  assert.equal(
    run.snapshotLoaderHash,
    runs[0].snapshotLoaderHash,
    "Loader changed during the balanced run",
  );
  for (const name of [
    "input-dialog",
    "dialog-actions",
    "select-list-component",
    "select-list-host",
    "input-dialog-host",
    "modal-dialog-factory",
  ])
    assert.equal(run.sources[name], runs[0].sources[name], `${name} changed between processes`);
  const variant = run.label.endsWith("-before") ? "before" : "after";
  const manifest = read(`${variant}/manifest.json`);
  assert.deepEqual(run.snapshot, manifest, `${variant}: snapshot changed between runs`);
  for (const [name, actual] of Object.entries(run.sources)) {
    if (name.includes("/"))
      assert.equal(
        actual,
        manifest.hashes[name],
        `${variant}/${name}: loaded source differs from snapshot`,
      );
  }
  for (const entry of run.cases) {
    const workload = corpus.workloads.find((value) => value.count === entry.count);
    assert.equal(run.corpusHash, workload.hash, "Corpus differs from frozen workload");
    assert.equal(
      run.projectCorpusHash,
      workload.hash,
      "Project corpus differs from frozen workload",
    );
    const key = `${entry.count}/${entry.package}`;
    if (!groups.has(key))
      groups.set(key, {
        count: entry.count,
        package: entry.package,
        worker: run.worker,
        resultSets: entry.resultSets,
        corpusHash: run.corpusHash,
        before: [],
        after: [],
      });
    const group = groups.get(key);
    assert.equal(group.corpusHash, run.corpusHash);
    assert.deepEqual(entry.resultSets, group.resultSets, `${key}: complete ordering changed`);
    completeOrderedComparisons += entry.resultSets.length;
    group[variant].push(entry);
  }
}
for (const variant of ["before", "after"]) {
  const manifest = read(`${variant}/manifest.json`);
  for (const [file, expected] of Object.entries(manifest.hashes)) {
    const actual = crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(directory, variant, file)))
      .digest("hex");
    assert.equal(actual, expected, `${variant}/${file} changed during the run`);
  }
}
const comparisons = [...groups.values()].map((group) => {
  assert.equal(group.before.length, group.after.length);
  assert.ok(group.before.length >= 2);
  const results = group.before[0].results.map(({ id }) => {
    const before = stats(
      group.before.flatMap((entry) => entry.results.find((value) => value.id === id).samples),
    );
    const after = stats(
      group.after.flatMap((entry) => entry.results.find((value) => value.id === id).samples),
    );
    return {
      id,
      before,
      after,
      medianRatio: after.median / before.median,
      medianChange: after.median - before.median,
    };
  });
  return {
    count: group.count,
    package: group.package,
    worker: group.worker,
    corpusHash: group.corpusHash,
    resultSets: group.resultSets,
    initialOpen: {
      before: group.before.map((entry) => entry.initialOpen),
      after: group.after.map((entry) => entry.initialOpen),
    },
    initialQuery: {
      before: group.before.map((entry) => entry.initialQuery),
      after: group.after.map((entry) => entry.initialQuery),
    },
    results,
  };
});
const output = path.resolve(__dirname, "results/fuzzy-search-review-2026-10-23.json");
const libraryRuns = fs.existsSync(path.join(directory, "library-runs.json"))
  ? read("library-runs.json")
  : [];
const libraryGroups = new Map();
for (const run of libraryRuns) {
  assert.equal(run.driverHash, libraryRuns[0].driverHash);
  assert.deepEqual(run.snapshot, read(`${run.variant}/manifest.json`));
  for (const entry of run.results) {
    const key = `${entry.count}/${entry.algorithm}`;
    const workload = corpus.workloads.find((value) => value.count === entry.count);
    assert.equal(entry.corpusHash, workload.hash);
    if (!libraryGroups.has(key))
      libraryGroups.set(key, {
        count: entry.count,
        algorithm: entry.algorithm,
        orderedResults: entry.orderedResults,
        before: [],
        after: [],
      });
    const group = libraryGroups.get(key);
    assert.deepEqual(
      entry.orderedResults,
      group.orderedResults,
      `${key}: library ordering or scores changed`,
    );
    group[run.variant].push(entry);
  }
  for (let index = 0; index < run.traces.length; index++)
    assert.equal(run.traces[index].outputHash, libraryRuns[0].traces[index].outputHash);
}
const libraryComparisons = [...libraryGroups.values()].map((group) => {
  assert.equal(group.before.length, 2);
  assert.equal(group.after.length, 2);
  return {
    count: group.count,
    algorithm: group.algorithm,
    results: Object.keys(group.before[0].timings).map((id) => {
      const before = stats(group.before.flatMap((entry) => entry.timings[id]));
      const after = stats(group.after.flatMap((entry) => entry.timings[id]));
      return {
        id,
        before,
        after,
        medianRatio: after.median / before.median,
        medianChange: after.median - before.median,
      };
    }),
  };
});
const report = {
  description:
    "Balanced before/after review comparison, genuine Chromium workers and explicit synchronous small lists.",
  measuredAt: runs.at(-1).finishedAt,
  corpus: {
    originalCount: corpus.originalCount,
    repositoryCount: corpus.repositories.length,
    sourceInventoryHash: crypto
      .createHash("sha256")
      .update(JSON.stringify(corpus.repositories))
      .digest("hex"),
    construction:
      "Git-tracked relative paths in active flat repositories, deterministically repeated under copy-NNN directories to reach 100, 30253, 100000 and 500000 unique absolute path strings. Only one active document exists; no synthetic file tree is created.",
    workloads: corpus.workloads.map(({ count, hash, worker }) => ({ count, hash, worker })),
  },
  completeOrderedComparisons,
  comparisons,
  libraryComparisons,
  libraryRuns,
  runs,
};
fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
for (const comparison of comparisons) {
  console.log(
    `${comparison.count} ${comparison.package} ${comparison.worker ? "worker" : "synchronous"}`,
  );
  for (const row of comparison.results.filter(({ id }) =>
    [
      "open",
      "open/longest-task-gap",
      "0/s",
      "0/s/longest-task-gap",
      "0/s/sync",
      "1/se",
      "2/sel",
      "3/se",
      "4/s",
      "5/(empty)",
      "selection",
    ].includes(id),
  ))
    console.log(
      `${row.id.padEnd(28)} ${row.before.median.toFixed(2).padStart(9)} → ${row.after.median.toFixed(2).padStart(9)} (${((row.medianRatio - 1) * 100).toFixed(1)}%) p95 ${row.before.p95.toFixed(2)} → ${row.after.p95.toFixed(2)}`,
    );
}
console.log(JSON.stringify({ output, completeOrderedComparisons }));
