const { test } = require("node:test");
const assert = require("node:assert/strict");
const TextStore = require("../../src/text-store");
const WordIndex = require("../../src/word-index");

const fixture = (count = 700) =>
  Array.from(
    { length: count },
    (_, row) => `const candidate_${row} = candidate; İstanbul ΟΣ 𐐀abc foo-bar x.x candidate\r\n`,
  ).join("");
async function equivalent(indexed, scan, query = "ca", options = {}) {
  assert.deepEqual(
    await indexed.findWordCandidates(query, options),
    await scan.findWordCandidates(query, options),
  );
}
function pair(text) {
  return [new TextStore(text), new TextStore(text, { wordIndex: false })];
}

test("prefix refinement reuses whole-block candidates across ranges and rebased rows", async () => {
  const source = new TextStore(fixture());
  const scan = new TextStore(source.getText(), { wordIndex: false });
  const index = new WordIndex();
  const find = (query, start = 0, end = 700) =>
    index.find(source.getTextSnapshot(), start, end, query, "_", 1000, {
      position: { row: 300, column: 40 },
    });
  await find("ca");
  for (const block of index.blocks) {
    block.words[Symbol.iterator] = () => {
      throw new Error("Refining a query must not revisit rejected block words");
    };
  }
  for (const query of ["can", "candidate", "candidate_6", "candidate_6"]) {
    assert.deepEqual(
      await find(query),
      await scan.findWordCandidates(query, {
        extraWordCharacters: "_",
        maxCount: 1000,
        position: { row: 300, column: 40 },
        range: { start: { row: 0, column: 0 }, end: { row: 700, column: 0 } },
      }),
    );
  }
  // A different query must be allowed to see previously rejected words again.
  for (const block of index.blocks) delete block.words[Symbol.iterator];
  for (const query of ["ca", "ΟΣ", "ΟΣΑ", "i", "İ", ""]) {
    assert.deepEqual(
      await find(query),
      await scan.findWordCandidates(query, {
        extraWordCharacters: "_",
        maxCount: 1000,
        position: { row: 300, column: 40 },
        range: { start: { row: 0, column: 0 }, end: { row: 700, column: 0 } },
      }),
    );
  }
});

test("refined filters preserve clipping, edits and interleaved query snapshots", async () => {
  const stores = pair(fixture());
  await equivalent(...stores, "c");
  for (const query of ["ca", "can", "candidate", "candidate_6"]) {
    await equivalent(...stores, query, {
      range: { start: { row: 250, column: 0 }, end: { row: 650, column: 0 } },
    });
    for (const store of stores)
      store.setTextInRange({ start: { row: 0, column: 0 }, end: { row: 0, column: 0 } }, "new\n");
    await equivalent(...stores, query);
  }
  for (const query of ["ca", "candidate_1", "ca", "candidate_6", "ΟΣ", ""]) {
    const pending = stores[0].findWordCandidates(query);
    const expected = stores[1].findWordCandidates(query);
    await stores[0].findWordCandidates("unmatched");
    assert.deepEqual(await pending, await expected);
  }
});

test("indexed words equal scanning for ranges, Unicode, custom tokens and locality", async () => {
  const [indexed, scan] = pair(fixture());
  for (const extraWordCharacters of ["_", "", "_.-", "[]\\"]) {
    for (const query of ["ca", "", "i", "ος", "abc", "x", "unmatched"]) {
      for (const range of [
        undefined,
        { start: { row: 61, column: 0 }, end: { row: 619, column: 0 } },
        { start: { row: 200, column: 3 }, end: { row: 401, column: 17 } },
      ]) {
        await equivalent(indexed, scan, query, {
          extraWordCharacters,
          range,
          position: { row: 300, column: 40 },
        });
      }
    }
  }
});

test("index follows edits at block boundaries, multiline edits, batch edits and resets", async () => {
  const stores = pair(fixture());
  const check = () =>
    equivalent(...stores, "ca", { extraWordCharacters: "_", position: { row: 500, column: 10 } });
  await check();
  for (const [start, end, text] of [
    [[128, 0], [128, 0], "candidateNew\n"],
    [[127, 3], [130, 20], "candidateMerged"],
    [[0, 0], [0, 0], "prefix\n"],
    [[256, 0], [512, 0], ""],
    [[100, 0], [100, 0], "ca\r\nca\n"],
  ]) {
    for (const store of stores)
      store.setTextInRange(
        { start: { row: start[0], column: start[1] }, end: { row: end[0], column: end[1] } },
        text,
      );
    await check();
  }
  for (const store of stores) {
    const edit = store.prepareEdits([
      { start: 0, end: 3, text: "candidate\nnew" },
      { start: 200, end: 210, text: "ca\n" },
    ]);
    edit.commit();
    edit.dispose();
  }
  await check();
  for (const store of stores) store.reset("candidateReset\nca");
  await check();
});

test("multiline batches translate retained word blocks like a fresh scanner", async () => {
  const stores = pair(fixture());
  await equivalent(...stores, "ca", { extraWordCharacters: "_", maxCount: 1000 });
  for (const store of stores) {
    const edits = Array.from({ length: 80 }, (_, row) => ({
      start: store.characterIndexForPosition({ row, column: 0 }),
      end: store.characterIndexForPosition({ row, column: 5 }),
      text: row % 2 ? "" : "candidateAdded\nnewRow\nconst",
    }));
    const batch = store.prepareEdits(edits);
    batch.commit();
    batch.dispose();
  }
  for (const row of [0, 260, 600, 760])
    await equivalent(...stores, "ca", {
      extraWordCharacters: "_",
      position: { row, column: 1 },
      maxCount: 1000,
    });
});

test("running queries retain invocation snapshots and cannot publish stale blocks", async () => {
  const [indexed, scan] = pair(fixture());
  await equivalent(indexed, scan);
  const position = { row: 100, column: 0 };
  const expected = scan.findWordCandidates("ca", { position });
  const pending = indexed.findWordCandidates("ca", { position });
  position.row = 1;
  indexed.setText("candidateReplacement\n");
  assert.deepEqual(await pending, await expected);
  await equivalent(indexed, new TextStore(indexed.getText(), { wordIndex: false }));
  const cold = new TextStore(fixture());
  const obsolete = cold.findWordCandidates("ca");
  cold.reset("candidateNew");
  await obsolete;
  await equivalent(cold, new TextStore("candidateNew", { wordIndex: false }));
});

test("cancellation and token configuration changes leave no stale results", async () => {
  const [indexed, scan] = pair(fixture());
  const controller = new AbortController();
  const result = indexed.findWordCandidates("ca", { signal: controller.signal });
  controller.abort();
  assert.deepEqual(await result, []);
  const a = indexed.findWordCandidates("foo", { extraWordCharacters: "-" });
  const b = indexed.findWordCandidates("foo", { extraWordCharacters: "" });
  assert.deepEqual(await a, await scan.findWordCandidates("foo", { extraWordCharacters: "-" }));
  assert.deepEqual(await b, await scan.findWordCandidates("foo"));
  await equivalent(indexed, scan, "foo");
});

test("dense occurrences preserve nearest rows and inclusive word-end containment", async () => {
  const stores = pair("candidate candidate candidate\n".repeat(300));
  for (const column of [0, 9, 10, 19, 20, 29, 30]) {
    for (const row of [0, 127, 128, 299, 300]) {
      await equivalent(...stores, "ca", { position: { row, column } });
      await equivalent(...stores, "ca", {
        range: { start: { row: 128, column: 0 }, end: { row: 200, column: 0 } },
        position: { row, column },
      });
    }
  }
});

test("discarded prepared edits leave cached candidates valid", async () => {
  const stores = pair(fixture());
  await equivalent(...stores);
  for (const store of stores) {
    const edit = store.prepareEdit(
      { start: { row: 0, column: 0 }, end: { row: 500, column: 0 } },
      "replacement",
    );
    edit.dispose();
    const batch = store.prepareEdits([{ start: 0, end: 10, text: "replacement\n" }]);
    batch.dispose();
  }
  await equivalent(...stores);
});

test("random edits preserve counts, absolute positions and cursor containment", async () => {
  const stores = pair(fixture(400));
  let seed = 1337;
  const random = (n) => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n;
  const inserts = ["ca", "\n", " ", "\r\n", "𐐀", "candidateNew_", ""];
  for (let step = 0; step < 120; step++) {
    const row = random(stores[0].getLineCount());
    const column = random(stores[0].lineLengthForRow(row) + 1);
    const endRow = Math.min(row + random(3), stores[0].getLineCount() - 1);
    const endColumn = endRow === row ? column + random(8) : random(20);
    const text = inserts[random(inserts.length)];
    for (const store of stores)
      store.setTextInRange(
        { start: { row, column }, end: { row: endRow, column: endColumn } },
        text,
      );
    await equivalent(...stores, step % 2 ? "ca" : "", {
      extraWordCharacters: "_",
      position: { row, column },
      maxCount: 40,
    });
  }
});

test("cache bounds survive browsing and long lines fall back to streaming scans", async () => {
  const index = new WordIndex();
  const store = new TextStore(fixture(10000));
  const snapshot = store.getTextSnapshot();
  for (let row = 0; row < 10000; row += 500)
    await index.find(snapshot, row, Math.min(row + 500, 10000), "ca", "_", 20, {});
  assert(index.blocks.length <= 64);
  assert(index.blocks.reduce((n, block) => n + block.units, 0) <= 2 * 1024 * 1024);
  assert(index.blocks.reduce((n, block) => n + block.occurrences, 0) <= 100000);
  const [indexed, scan] = pair("candidate ".repeat(220000));
  await equivalent(indexed, scan);
});
