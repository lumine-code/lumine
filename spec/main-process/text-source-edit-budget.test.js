const { test } = require("node:test");
const assert = require("node:assert/strict");
const TextBuffer = require("../../src/text-buffer");
const { autoIndentRanges } = require("../../src/text-editor-auto-indent");

function timing(context) {
  let now = 0,
    yields = 0;
  const immediate = globalThis.setImmediate;
  context.mock.method(performance, "now", () => now);
  context.mock.method(globalThis, "setImmediate", (callback, ...args) => {
    yields++;
    return immediate(callback, ...args);
  });
  return {
    advance: (time) => {
      now = time;
    },
    get yields() {
      return yields;
    },
  };
}

function editorFor(buffer) {
  return {
    getBuffer: () => buffer,
    getTabLength: () => 4,
    getSoftTabs: () => true,
    captureTextMutationGuard: () => () => true,
    withAutomaticIndentation: (callback) => callback(),
  };
}

test("waiting for the first text edit does not spend its processing budget", async (context) => {
  const buffer = new TextBuffer("word");
  const clock = timing(context);
  try {
    await buffer.applyTextEdits(
      (async function* () {
        await Promise.resolve();
        clock.advance(50);
        yield [];
        await Promise.resolve();
        clock.advance(100);
        yield {
          range: [
            [0, 0],
            [0, 0],
          ],
          text: "    ",
        };
      })(),
    );
    assert.equal(buffer.getText(), "    word");
    assert.equal(clock.yields, 0);
  } finally {
    buffer.destroy();
  }
});

test("waiting for indentation does not add idle turns before publishing one prefix", async (context) => {
  const buffer = new TextBuffer("word");
  const clock = timing(context);
  buffer.getLanguageMode().scanSuggestedIndentation = async function* () {
    await Promise.resolve();
    clock.advance(50);
    yield [];
    await Promise.resolve();
    clock.advance(100);
    yield [[0, 1]];
  };
  try {
    await autoIndentRanges(editorFor(buffer), [[0, 0]]);
    assert.equal(buffer.getText(), "    word");
    assert.equal(clock.yields, 0);
  } finally {
    buffer.destroy();
  }
});

test("text edits retain their processing deadline across subsequent batches", async (context) => {
  const buffer = new TextBuffer("one\ntwo");
  const clock = timing(context);
  try {
    await buffer.applyTextEdits(
      (async function* () {
        yield {
          range: [
            [0, 0],
            [0, 0],
          ],
          text: " ",
        };
        clock.advance(5);
        yield {
          range: [
            [1, 0],
            [1, 0],
          ],
          text: " ",
        };
      })(),
    );
    assert.equal(buffer.getText(), " one\n two");
    assert.equal(clock.yields, 1);
  } finally {
    buffer.destroy();
  }
});

test("indentation keeps its processing deadline across subsequent result batches", async (context) => {
  const buffer = new TextBuffer("one\ntwo");
  const clock = timing(context);
  buffer.getLanguageMode().scanSuggestedIndentation = async function* () {
    yield [[0, 1]];
    clock.advance(5);
    yield [[1, 1]];
  };
  const batches = [];
  buffer.applyTextEdits = async (edits) => {
    for await (const batch of edits) batches.push(batch);
    return batches.length;
  };
  try {
    await autoIndentRanges(editorFor(buffer), [[0, 1]]);
    assert.equal(batches.length, 2);
    assert.equal(clock.yields, 1);
  } finally {
    buffer.destroy();
  }
});
