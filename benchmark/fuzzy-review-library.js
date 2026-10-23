"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const directory = path.resolve(__dirname, "../../.dev/fuzzy-performance-review-20261023");
const variant = process.argv[2];
const output = process.argv[3];
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const snapshot = JSON.parse(fs.readFileSync(path.join(directory, variant, "manifest.json")));
const { Matcher } = require(path.join(directory, variant, "fuzzy-search/lib/main.js"));
const results = [];
for (const count of [100, 100000, 500000]) {
  const bytes = fs.readFileSync(path.join(directory, `corpus-${count}.json`));
  const values = JSON.parse(bytes);
  const ids = values.map((_, index) => index);
  for (const algorithm of ["command-t", "fuzzaldrin"]) {
    const timings = new Map();
    const orderedResults = [];
    const record = (id, elapsed, sample) => {
      if (sample < 0) return;
      if (!timings.has(id)) timings.set(id, []);
      timings.get(id).push(elapsed);
    };
    for (let sample = -1; sample < 3; sample++) {
      global.gc?.();
      let started = performance.now();
      const matcher = new Matcher(ids, values, { ignoreDiacritics: true });
      record("prepare", performance.now() - started, sample);
      for (const [index, query] of [
        "s",
        "se",
        "sel",
        "se",
        "s",
        "",
        "a",
        "ab",
        "a",
        "",
      ].entries()) {
        started = performance.now();
        const matches = matcher.match(query, { algorithm });
        record(`${index}/${query || "(empty)"}`, performance.now() - started, sample);
        if (sample >= 0) {
          const result = {
            query,
            count: matches.length,
            orderedIdsAndScoresHash: hash(
              JSON.stringify(matches.map(({ id, score }) => [id, score])),
            ),
          };
          if (sample === 0) orderedResults.push(result);
          else assert.deepEqual(result, orderedResults[index]);
        }
      }
    }
    results.push({
      count,
      algorithm,
      corpusHash: hash(bytes),
      orderedResults,
      timings: Object.fromEntries(timings),
    });
  }
}
const traces = [];
for (const algorithm of ["command-t", "fuzzaldrin"]) {
  const query = "é".repeat(1100) + "abc";
  const value = "🙂" + query;
  const expected = Array.from({ length: 1103 }, (_, index) => index + 2);
  const samples = [];
  let result;
  for (let sample = -1; sample < 3; sample++) {
    const matchers = Array.from({ length: 100 }, () => new Matcher([0], [value]));
    const started = performance.now();
    for (const matcher of matchers)
      result = matcher.match(query, { algorithm, recordMatchIndexes: true });
    const elapsed = performance.now() - started;
    assert.deepEqual(result[0].matchIndexes, expected);
    if (sample >= 0) samples.push(elapsed);
  }
  traces.push({
    algorithm,
    repetitions: 100,
    utf16Length: value.length,
    queryLength: query.length,
    outputHash: hash(JSON.stringify(result)),
    samples,
  });
}
fs.writeFileSync(
  output,
  JSON.stringify(
    {
      variant,
      runtime: process.versions,
      driverHash: hash(fs.readFileSync(__filename)),
      snapshot,
      results,
      traces,
    },
    null,
    2,
  ),
);
