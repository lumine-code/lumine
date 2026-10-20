// Compare scanning and the bounded edit-aware word index in fresh Node processes.
// node --expose-gc benchmark/word-index-benchmark.js --mode index --output report.json
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const assert = require("node:assert/strict");
const args = process.argv.slice(2);
const option = (key, fallback) =>
  args.includes(`--${key}`) ? args[args.indexOf(`--${key}`) + 1] : fallback;
const mode = option("mode", "index");
const core = path.resolve(option("core", path.join(__dirname, "..")));
const TextStore = require(path.join(core, "src/text-store"));
assert(["scan", "index"].includes(mode));
const samples = Number(option("samples", 9)),
  warmups = Number(option("warmups", 3));
const results = [];
const makeStore = (text) => new TextStore(text, { wordIndex: mode === "index" });
const fixtures = [
  { id: "repeated-100", rows: 100 },
  { id: "repeated-6000", rows: 6000 },
  { id: "unique-6000", rows: 6000, unique: true },
  { id: "window-100000", rows: 100000, window: true },
  { id: "long-line", rows: 1, long: true },
];
function textFor(fixture) {
  if (fixture.long) return "candidateAlpha candidateBeta ".repeat(90000);
  return Array.from(
    { length: fixture.rows },
    (_, row) =>
      `const candidate${fixture.unique ? row : "Alpha"} = candidateBeta + candidateGamma; // Ελληνικά\n`,
  ).join("");
}
function optionsFor(fixture) {
  const row = fixture.window ? 50000 : Math.floor(fixture.rows / 2);
  return {
    position: { row, column: 10 },
    maxCount: 20,
    range: fixture.window
      ? { start: { row: row - 3000, column: 0 }, end: { row: row + 3000, column: 0 } }
      : undefined,
  };
}
const summarize = (values) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    samples: values,
  };
};
async function measure(id, setup, run, verify) {
  const times = [],
    editTimes = [];
  for (let sample = -warmups; sample < samples; sample++) {
    const context = await setup();
    global.gc?.();
    const start = performance.now();
    const result = await run(context);
    const elapsed = performance.now() - start;
    await verify(result, context);
    if (sample >= 0) {
      times.push(elapsed);
      if (context.editTime != null) editTimes.push(context.editTime);
    }
  }
  results.push({
    id,
    ...summarize(times),
    ...(editTimes.length ? { edit: summarize(editTimes) } : {}),
  });
}

(async () => {
  if (args.includes("--memory")) {
    assert(global.gc, "Memory measurements require --expose-gc");
    // Compile both paths before measuring retained heap in this fresh process.
    for (const enabled of [false, true]) {
      const warm = new TextStore(textFor({ rows: 6000 }), { wordIndex: enabled });
      await warm.findWordCandidates("ca");
    }
    const collect = async () => {
      await new Promise((resolve) => setImmediate(resolve));
      global.gc();
      global.gc();
      return process.memoryUsage().heapUsed;
    };
    for (const fixture of fixtures.filter((f) => !f.long)) {
      const text = textFor(fixture),
        options = optionsFor(fixture),
        values = [];
      for (let trial = 0; trial < 3; trial++) {
        global.wordIndexMemoryStores = Array.from({ length: 8 }, () => makeStore(text));
        const before = await collect();
        for (const store of global.wordIndexMemoryStores)
          await store.findWordCandidates("ca", options);
        const after = await collect();
        values.push((after - before) / global.wordIndexMemoryStores.length);
        assert(global.wordIndexMemoryStores.every((store) => store.getLength() === text.length));
        global.wordIndexMemoryStores = null;
        await collect();
      }
      results.push({
        id: `${fixture.id}/retained-heap-per-buffer`,
        unit: "bytes",
        ...summarize(values),
      });
    }
  } else {
    for (const fixture of fixtures) {
      const text = textFor(fixture),
        options = optionsFor(fixture);
      const oracle = new TextStore(text, { wordIndex: false });
      const expected = await oracle.findWordCandidates("ca", options);
      const verify = (result) => assert.deepEqual(result, expected);
      await measure(
        `${fixture.id}/cold`,
        () => ({ store: makeStore(text) }),
        ({ store }) => store.findWordCandidates("ca", options),
        verify,
      );
      const store = makeStore(text);
      await store.findWordCandidates("ca", options);
      await measure(
        `${fixture.id}/warm`,
        () => ({ store }),
        ({ store }) => store.findWordCandidates("ca", options),
        verify,
      );
      for (const query of ["cG", "notPresent"]) {
        const expectedQuery = await oracle.findWordCandidates(query, options);
        await measure(
          `${fixture.id}/warm-${query}`,
          () => ({ store }),
          ({ store }) => store.findWordCandidates(query, options),
          (result) => assert.deepEqual(result, expectedQuery),
        );
      }
      if (fixture.long) continue;
      for (const kind of ["type", "newline", "paste", "bulk"]) {
        const changed = makeStore(text);
        await changed.findWordCandidates("ca", options);
        const row = options.position.row;
        const range = { start: { row, column: 6 }, end: { row, column: 6 } };
        const insertion =
          kind === "type" ? "X" : kind === "newline" ? "\n" : "candidatePasted\n".repeat(200);
        const edit = (target) => {
          if (kind === "bulk") {
            const edits = Array.from({ length: Math.min(fixture.rows, 6000) }, (_, i) => {
              const start = target.characterIndexForPosition({
                row: (fixture.window ? 47000 : 0) + i,
                column: 0,
              });
              return { start, end: start, text: " " };
            });
            const prepared = target.prepareEdits(edits);
            prepared.commit();
            prepared.dispose();
          } else target.setTextInRange(range, insertion);
        };
        const check = new TextStore(text, { wordIndex: false });
        edit(check);
        const expectedEdited = await check.findWordCandidates("ca", options);
        await measure(
          `${fixture.id}/${kind}+query`,
          async () => {
            changed.reset(text);
            await changed.findWordCandidates("ca", options);
            return { store: changed };
          },
          async (context) => {
            const start = performance.now();
            edit(context.store);
            context.editTime = performance.now() - start;
            return context.store.findWordCandidates("ca", options);
          },
          (result) => assert.deepEqual(result, expectedEdited),
        );
      }
    }
    const text = textFor({ rows: 6000 });
    const stores = Array.from({ length: 8 }, () => makeStore(text));
    for (const store of stores) await store.findWordCandidates("ca");
    await measure(
      "eight-buffers/warm",
      () => ({}),
      () => Promise.all(stores.map((store) => store.findWordCandidates("ca"))),
      (result) => assert.equal(result.length, 8),
    );
  }
  const files = [
    "text-store.js",
    "text-store-search.js",
    "word-index.js",
    "completion-matcher.js",
    "piece-tree.js",
    "text-model.js",
  ].filter((file) => fs.existsSync(path.join(core, "src", file)));
  const sourceHashes = Object.fromEntries(
    files.map((name) => [
      name,
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(core, "src", name)))
        .digest("hex"),
    ]),
  );
  const output = {
    mode,
    node: process.version,
    samples,
    warmups,
    sourceHashes,
    driverHash: crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex"),
    results,
  };
  fs.writeFileSync(
    option("output", "word-index-results.json"),
    JSON.stringify(output, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      results.map(({ id, median, bytes, edit }) => ({ id, median, bytes, edit: edit?.median })),
    ),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
