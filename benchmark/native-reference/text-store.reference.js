const { test } = require("node:test");
const assert = require("node:assert/strict");
const TextStore = require("../../src/text-store");
test("fuzzy scores, tie-breaking paths and positions match the native reference", async () => {
  const NativeStore = require("../../script/native-superstring-reference").load().TextBuffer;
  const clean = (values) =>
    values.map(({ word, score, matchIndices, positions }) => ({
      word,
      score,
      matchIndices,
      positions,
    }));
  let seed = 17;
  const random = (limit) => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % limit;
  const alphabet = "abcABC012_";
  for (let trial = 0; trial < 40; trial++) {
    const words = Array.from({ length: 150 }, () =>
      Array.from({ length: random(25) + 1 }, () => alphabet[random(alphabet.length)]).join(""),
    );
    const source = words.join(" \n");
    const js = new TextStore(source),
      native = new NativeStore(source);
    for (const query of ["abc", "aB", "0a", "A", "bca", ""])
      assert.deepEqual(
        clean(await js.findWordsWithSubsequence(query, "_", 20)),
        clean(await native.findWordsWithSubsequence(query, "_", 20)),
        `${trial}: ${query}`,
      );
  }
});

test("completion coordinates survive long lines, split words and newline word characters", async () => {
  const { findWords } = require("../../src/text-store-search");
  const NativeStore = require("../../script/native-superstring-reference").load().TextBuffer;
  for (const [source, extra, query] of [
    ["abc abcX ".repeat(8000) + "\r\nabcEnd", "_", "ac"],
    ["ab\ncd ef\r\nab_cd\nlast", "_\n", "ac"],
    ["ab cd\r\nab_cd\nlast", "_ ", "ac"],
  ]) {
    const expected = (await new NativeStore(source).findWordsWithSubsequence(query, extra, 10)).map(
      ({ word, score, matchIndices, positions }) => ({ word, score, matchIndices, positions }),
    );
    for (const size of [31, 32768]) {
      const text = {
        *chunks() {
          for (let offset = 0; offset < source.length; offset += size)
            yield source.slice(offset, offset + size);
        },
      };
      assert.deepEqual(await findWords(text, query, extra, 10), expected);
    }
  }
});
