const TextEditor = require("../src/text-editor");
const TextBuffer = require("../src/text-buffer");
const Clipboard = require("../src/clipboard");
const clipboardBridge = require("../src/clipboard-bridge");
const { PieceTree } = require("../src/text-model");

function random(seed) {
  return () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000;
}

function pointAt(text, offset, firstRow = 0) {
  let row = firstRow,
    start = 0;
  for (let i = 0; i < offset; i++)
    if (text.charCodeAt(i) === 10) {
      row++;
      start = i + 1;
    }
  return [row, offset - start];
}

function offsetAt(text, point, firstRow = 0) {
  let offset = 0;
  for (let row = firstRow; row < point.row; row++) offset = text.indexOf("\n", offset) + 1;
  return offset + point.column;
}

function replaceRanges(text, ranges, replacements) {
  for (let i = ranges.length - 1; i >= 0; i--)
    text = text.slice(0, ranges[i][0]) + replacements[i] + text.slice(ranges[i][1]);
  return text;
}

function normalizeClipboard(text) {
  return text.replace(/\r\n?|\n/g, process.platform === "win32" ? "\r\n" : "\n");
}

function unionRanges(ranges, touching = false) {
  const result = [];
  for (const range of ranges.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const previous = result.at(-1);
    if (
      previous &&
      (range[0] < previous[1] ||
        (range[0] === previous[1] &&
          (touching || range[0] === range[1] || previous[0] === previous[1])))
    )
      previous[1] = Math.max(previous[1], range[1]);
    else result.push(range.slice());
  }
  return result;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("Large document editing workflow differentials", () => {
  let editors, nativeText, clipboard, previousClipboard, writes;
  beforeEach(() => {
    jasmine.useRealClock();
    editors = [];
    writes = [];
    nativeText = "";
    previousClipboard = TextEditor.clipboard;
    clipboard = TextEditor.clipboard = new Clipboard();
    // Exercise the real Clipboard metadata/EOL pipeline, but never touch any
    // OS clipboard (including Linux PRIMARY and Chromium's native commands).
    clipboardBridge.writeText.and.callFake(async (text, type) => {
      if (type !== "selection") {
        nativeText = text;
        writes.push(text);
      }
    });
    clipboardBridge.readText.and.callFake(async (type) => (type === "selection" ? "" : nativeText));
    if (typeof document.execCommand === "function")
      spyOn(document, "execCommand").and.returnValue(false);
    spyOn(clipboardBridge, "readImage").and.throwError("Unexpected OS image clipboard access");
    lumine.config.set("editor.autoIndentOnPaste", false);
  });
  afterEach(() => {
    for (const editor of editors) editor.destroy();
    TextEditor.clipboard = previousClipboard;
  });

  function create(text, giant = false, unit = "x") {
    let prefix = new PieceTree();
    if (giant) {
      prefix = new PieceTree(unit.repeat(32768));
      while (prefix.canMaterialize()) prefix = prefix.replace(prefix.length, prefix.length, prefix);
      prefix = prefix.replace(prefix.length, prefix.length, "\n");
    }
    const buffer = new TextBuffer();
    buffer.setTextInRange(buffer.getRange(), prefix.replace(prefix.length, prefix.length, text), {
      normalizeLineEndings: false,
    });
    buffer.clearUndoStack();
    const editor = new TextEditor({
      buffer,
      softWrapped: false,
      autoHeight: false,
      autoIndent: false,
      undoGroupingInterval: 0,
      tabLength: 2,
      softTabs: true,
    });
    editors.push(editor);
    if (giant) {
      spyOn(buffer, "getText").and.throwError("Whole huge document materialization");
      const read = buffer.getTextInRange.bind(buffer);
      spyOn(buffer, "getTextInRange").and.callFake((range) => {
        range = buffer.clipRange(range);
        const length =
          buffer.characterIndexForPosition(range.end) -
          buffer.characterIndexForPosition(range.start);
        if (length > 65536) throw Error("Unbounded selected text materialization");
        return read(range);
      });
    }
    return { editor, buffer, prefix, firstRow: giant ? 1 : 0 };
  }

  function selections(editor) {
    return editor.getSelections().map((selection) => ({
      range: selection.getBufferRange().serialize(),
      reversed: selection.isReversed(),
    }));
  }

  function assertEqual(actual, expected, context) {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw Error(
        `${context}\nexpected=${JSON.stringify(expected)}\nactual=${JSON.stringify(actual)}`,
      );
  }

  function assertText(state, expected, context) {
    const current = state.buffer.getTextSnapshot();
    assertEqual(current.length, state.prefix.length + expected.length, context + " length");
    assertEqual(current.subtext(state.prefix.length).toString(), expected, context + " text");
    assertEqual(
      current.subtext(0, state.prefix.length).equals(state.prefix),
      true,
      context + " untouched prefix",
    );
    assertEqual(
      current.lineCount,
      expected.split("\n").length + state.firstRow,
      context + " row count",
    );
  }

  async function command(editor, name) {
    await lumine.commands.dispatch(editor.getElement(), name);
  }

  for (const giant of [false, true])
    for (const seed of [0x5eed1234, 0xc0ffee, 0xa51a, 0x12345678, 0xdeadbeef, 0x5a17]) {
      it(`matches the string oracle through seeded clipboard/source/undo workflows ${seed.toString(16)} giant=${giant}`, async () => {
        const next = random(seed),
          pick = (values) => values[Math.floor(next() * values.length)];
        const fragments = [
          "Z",
          "😀",
          "e\u0301",
          "\r",
          "\n",
          "\r\n",
          "\t",
          "\ud800",
          "\u2028",
          " α\n  β",
          "",
        ];
        let oracle = "α\r\nbeta\rtab\t😀\nlast\u2028Z\n";
        const state = create(oracle, giant);
        const { editor, buffer, firstRow } = state;
        const trace = [];
        for (let step = 0; step < 60; step++) {
          const operation = pick(["insert", "source", "copy", "cut", "paste"]);
          const indices = Array.from({ length: oracle.length + 1 }, (_, i) => i).filter(
            (i) => !(oracle[i - 1] === "\r" && oracle[i] === "\n"),
          );
          const requested = [];
          for (let count = 1 + Math.floor(next() * 4); count--;) {
            let start = pick(indices),
              end = pick(
                next() < 0.15
                  ? indices
                  : indices.filter((index) => index >= start && index <= start + 12),
              );
            if (start > end) [start, end] = [end, start];
            if ((operation === "copy" || operation === "cut") && start === end) continue;
            requested.push([start, end]);
          }
          if (!requested.length) requested.push([0, oracle.length]);
          if ((operation === "copy" || operation === "cut") && !oracle.length) continue;
          editor.setSelectedBufferRanges(
            requested.map(([start, end]) => [
              pointAt(oracle, start, firstRow),
              pointAt(oracle, end, firstRow),
            ]),
            { reversed: next() > 0.5, autoscroll: false },
          );
          const ranges = editor.getSelectionsOrderedByBufferPosition().map((selection) => {
            const range = selection.getBufferRange();
            return [offsetAt(oracle, range.start, firstRow), offsetAt(oracle, range.end, firstRow)];
          });
          trace.push({ operation, before: oracle, requested, ranges });
          let context = `seed=${seed.toString(16)}, giant=${giant}, step=${step}, trace=${JSON.stringify(trace)}`;
          assertEqual(ranges, unionRanges(requested), context + " merged selections");
          const before = oracle,
            beforeSelections = selections(editor);
          if (operation === "copy" || operation === "cut") {
            const copiedRanges = operation === "cut" ? unionRanges(ranges, true) : ranges;
            const pieces = copiedRanges.map(([start, end]) => oracle.slice(start, end));
            await command(editor, operation === "copy" ? "core:copy" : "core:cut");
            assertEqual(
              nativeText,
              normalizeClipboard(pieces.join("\n")),
              context + " native clipboard",
            );
            if (operation === "cut")
              oracle = replaceRanges(
                oracle,
                ranges,
                ranges.map(() => ""),
              );
          } else if (operation === "paste") {
            if (next() > 0.5 || !nativeText) await clipboard.write(pick(fragments));
            const pieces =
              clipboard.metadata?.selections?.length === ranges.length
                ? clipboard.metadata.selections.map((selection) => selection.text)
                : ranges.map(() => nativeText);
            oracle = replaceRanges(oracle, ranges, pieces);
            await command(editor, "editor:paste-without-reformatting");
          } else {
            const pieces = ranges.map(() => pick(fragments));
            trace.at(-1).pieces = pieces;
            if (operation === "source") {
              buffer.setTextInIndependentRanges(
                ranges.map(([start, end], index) => ({
                  range: [pointAt(oracle, start, firstRow), pointAt(oracle, end, firstRow)],
                  text: new PieceTree(pieces[index]),
                })),
              );
              oracle = replaceRanges(oracle, ranges, pieces);
            } else {
              oracle = replaceRanges(
                oracle,
                ranges,
                ranges.map(() => pieces[0]),
              );
              editor.insertText(pieces[0], {
                autoIndent: false,
                autoIndentNewline: false,
                autoDecreaseIndent: false,
                normalizeLineEndings: false,
              });
            }
          }
          context = `seed=${seed.toString(16)}, giant=${giant}, step=${step}, trace=${JSON.stringify(trace)}`;
          assertText(state, oracle, context);
          if (before !== oracle) {
            const afterSelections = selections(editor);
            await command(editor, "core:undo");
            assertText(state, before, context + " undo");
            assertEqual(selections(editor), beforeSelections, context + " undo selection geometry");
            await command(editor, "core:redo");
            assertText(state, oracle, context + " redo");
            assertEqual(selections(editor), afterSelections, context + " redo selection geometry");
          } else if (operation === "copy" || operation === "source")
            assertEqual(selections(editor), beforeSelections, context + " nonmutating selections");
        }
      }, 60000);
    }

  it("cuts a line only once when two empty cursors select that same line", async () => {
    const state = create("alpha😀\r\nkeep this\r\nlast", true);
    state.editor.setSelectedBufferRanges([
      [
        [1, 1],
        [1, 1],
      ],
      [
        [1, 4],
        [1, 4],
      ],
    ]);
    const before = selections(state.editor);
    await command(state.editor, "core:cut");
    assertText(state, "keep this\r\nlast", "overlapping full-line cut");
    await command(state.editor, "core:undo");
    assertText(state, "alpha😀\r\nkeep this\r\nlast", "overlapping full-line cut undo");
    assertEqual(selections(state.editor), before, "overlapping full-line cut selections");
  });

  it("restores selection creation order and the active cursor after cutting adjacent ranges", async () => {
    const state = create("abcdefg\n", true);
    state.editor.setSelectedBufferRanges(
      [
        [
          [1, 4],
          [1, 6],
        ],
        [
          [1, 2],
          [1, 4],
        ],
        [
          [1, 0],
          [1, 1],
        ],
      ],
      { reversed: true },
    );
    const before = selections(state.editor);
    await command(state.editor, "core:cut");
    assertText(state, "bg\n", "adjacent cut text");
    await command(state.editor, "core:undo");
    assertText(state, "abcdefg\n", "adjacent cut undo");
    assertEqual(
      selections(state.editor),
      before,
      "adjacent cut undo creation order and active cursor",
    );
    for (let repeat = 0; repeat < 4; repeat++) {
      await command(state.editor, "core:redo");
      expect(state.editor.getSelections().length).toBe(2);
      assertText(state, "bg\n", "repeated adjacent redo");
      await command(state.editor, "core:undo");
      assertEqual(selections(state.editor), before, "repeated adjacent undo order");
    }
  });

  it("copies immutable full-line unions without transient selection events, including readonly editors", async () => {
    const state = create("  α😀\r\nlast", true),
      { editor } = state;
    editor.setSelectedBufferRanges([
      [
        [1, 1],
        [1, 1],
      ],
      [
        [1, 3],
        [1, 3],
      ],
    ]);
    editor.setReadOnly(true);
    const before = selections(editor),
      changed = jasmine.createSpy("selection changed");
    const subscription = editor.onDidChangeSelectionRange(changed);
    try {
      await command(editor, "core:copy");
      expect(nativeText).toBe(normalizeClipboard("  α😀\r\n"));
      expect(clipboard.metadata.fullLine).toBe(true);
      expect(clipboard.metadata.selections).toBeUndefined();
      expect(changed).not.toHaveBeenCalled();
      assertEqual(selections(editor), before, "readonly pure copy preserves selections");
    } finally {
      subscription.dispose();
    }
  });

  for (const kind of ["touching", "mixed", "eof"])
    it(`roundtrips ${kind} cut/paste plans without artificial separators`, async () => {
      const text = "alpha\nkeep this\nlast",
        state = create(text, true),
        { editor, buffer } = state;
      buffer.setPreferredLineEnding("\n");
      const ranges =
        kind === "touching"
          ? [
              [
                [1, 1],
                [1, 3],
              ],
              [
                [1, 3],
                [1, 5],
              ],
            ]
          : kind === "mixed"
            ? [
                [
                  [1, 1],
                  [1, 1],
                ],
                [
                  [1, 4],
                  [2, 3],
                ],
              ]
            : [
                [
                  [3, 2],
                  [3, 2],
                ],
              ];
      editor.setSelectedBufferRanges(ranges, { reversed: true });
      const before = selections(editor);
      if (kind === "touching") {
        await command(editor, "core:copy");
        expect(nativeText).toBe(normalizeClipboard("lp\nha"));
        expect(clipboard.metadata.selections.length).toBe(2);
      }
      await command(editor, "core:cut");
      const cutText =
        kind === "touching"
          ? "a\nkeep this\nlast"
          : kind === "mixed"
            ? "p this\nlast"
            : "alpha\nkeep this\n";
      assertText(state, cutText, "cut union");
      expect(clipboard.metadata.fullLine).toBe(kind === "eof");
      const cutSelections = selections(editor);
      await command(editor, "core:paste");
      assertText(state, text, "cut then paste roundtrip");
      await command(editor, "core:undo");
      assertText(state, cutText, "undo pasted union");
      assertEqual(selections(editor), cutSelections, "undo paste selections");
      await command(editor, "core:undo");
      assertText(state, text, "undo cut union");
      assertEqual(selections(editor), before, "undo cut restores original selections");
    });

  it("never deletes an uncopied character when cutting an empty selection at line end", async () => {
    const state = create("head\r\nkeep", true);
    state.editor.setCursorBufferPosition([1, 4]);
    await clipboard.write("previous");
    await state.editor.cutToEndOfBufferLine();
    await state.editor.getLastSelection().cut();
    assertText(state, "head\r\nkeep", "empty cut is a no-op");
    expect(nativeText).toBe("previous");
    expect(state.buffer.undo()).toBe(false);
  });

  it("records the final merged markers for direct source batches (seed 5a17)", async () => {
    const state = create("  ", true),
      { editor, buffer } = state;
    editor.setSelectedBufferRanges([
      [
        [1, 1],
        [1, 2],
      ],
      [
        [1, 0],
        [1, 1],
      ],
    ]);
    const before = selections(editor);
    buffer.setTextInIndependentRanges([
      {
        range: [
          [1, 0],
          [1, 1],
        ],
        text: new PieceTree(""),
      },
      {
        range: [
          [1, 1],
          [1, 2],
        ],
        text: new PieceTree("e\u0301"),
      },
    ]);
    const after = selections(editor);
    expect(after.length).toBe(1);
    for (let repeat = 0; repeat < 3; repeat++) {
      await command(editor, "core:undo");
      assertText(state, "  ", "source batch undo");
      assertEqual(selections(editor), before, "source batch undo markers");
      await command(editor, "core:redo");
      assertText(state, "e\u0301", "source batch redo");
      assertEqual(selections(editor), after, "source batch redo final merged markers");
    }
  });

  it("rolls back text, marker geometry and active cursor when finalization fails after merging", () => {
    const state = create("xx", true),
      { editor, buffer } = state;
    editor.setSelectedBufferRanges(
      [
        [
          [1, 1],
          [1, 2],
        ],
        [
          [1, 0],
          [1, 1],
        ],
      ],
      { reversed: true },
    );
    const before = selections(editor),
      finalizers = require("../src/text-buffer-marker-finalizers");
    const failure = new Error("Rejected marker finalization");
    const lease = finalizers.register(buffer, () => {
      expect(editor.getSelections().length).toBe(1);
      throw failure;
    });
    try {
      expect(() =>
        buffer.delete([
          [1, 0],
          [1, 1],
        ]),
      ).toThrow(failure);
      assertText(state, "xx", "failed finalizer source rollback");
      assertEqual(selections(editor), before, "failed finalizer marker and active cursor rollback");
      expect(buffer.undo()).toBe(false);
      expect(buffer.finalizingTransactionMarkers).toBe(false);
    } finally {
      lease.dispose();
    }
    buffer.delete([
      [1, 0],
      [1, 1],
    ]);
    assertText(state, "x", "retry after failed finalization");
    editor.undo();
    assertEqual(selections(editor), before, "retry undo selection order");
  });

  it("blocks text/history reentrancy, finalizes nesting once and skips no-op transactions", () => {
    const state = create("xx"),
      { editor, buffer } = state;
    editor.setSelectedBufferRanges([
      [
        [0, 0],
        [0, 1],
      ],
      [
        [0, 1],
        [0, 2],
      ],
    ]);
    let calls = 0;
    const update = jasmine.createSpy("selection marker update");
    const subscription = editor.selectionsMarkerLayer.onDidUpdate(update);
    const lease = require("../src/text-buffer-marker-finalizers").register(buffer, () => {
      calls++;
      for (const mutation of [
        () => buffer.append("bad"),
        () => buffer.clearUndoStack(),
        () => buffer.transact(() => buffer.append("bad")),
      ])
        expect(mutation).toThrowError(/marker finalization/);
    });
    try {
      buffer.transact(() =>
        buffer.transact(() =>
          buffer.delete([
            [0, 0],
            [0, 1],
          ]),
        ),
      );
      expect(calls).toBe(1);
      expect(update.calls.count()).toBe(1);
      buffer.transact(() => {});
      buffer.setTextInIndependentRanges([{ range: buffer.getRange(), text: new PieceTree("x") }]);
      expect(calls).toBe(1);
      editor.undo();
      assertText(state, "xx", "one real undo entry after no-op transactions");
      expect(buffer.undo()).toBe(false);
    } finally {
      lease.dispose();
      subscription.dispose();
    }
  });

  it("disposes an editor's finalizer while a shared buffer remains alive", () => {
    const state = create("xx"),
      { editor, buffer } = state;
    buffer.retain();
    const merge = spyOn(editor, "mergeIntersectingSelections").and.callThrough();
    editor.destroy();
    merge.calls.reset();
    try {
      buffer.append("tail");
      expect(merge).not.toHaveBeenCalled();
      expect(buffer.getText()).toBe("xxtail");
    } finally {
      buffer.release();
    }
  });

  it("rolls back applyTextEdits finalizer errors without falsely reporting a committed edit", async () => {
    const state = create("xx"),
      { editor, buffer } = state;
    editor.setSelectedBufferRanges([
      [
        [0, 1],
        [0, 2],
      ],
      [
        [0, 0],
        [0, 1],
      ],
    ]);
    const before = selections(editor),
      failure = new Error("Finalizer stopped edit");
    const lease = require("../src/text-buffer-marker-finalizers").register(buffer, () => {
      throw failure;
    });
    try {
      await expectAsync(
        buffer.applyTextEdits([
          {
            range: [
              [0, 0],
              [0, 1],
            ],
            text: new PieceTree(""),
          },
        ]),
      ).toBeRejectedWith(failure);
      assertText(state, "xx", "streamed edit rollback");
      assertEqual(selections(editor), before, "streamed edit rollback markers");
      expect(buffer.undo()).toBe(false);
    } finally {
      lease.dispose();
    }
  });

  it("restores live selection objects after a public removal observer throws during finalization", () => {
    const state = create("xx"),
      { editor, buffer } = state;
    editor.setSelectedBufferRanges(
      [
        [
          [0, 1],
          [0, 2],
        ],
        [
          [0, 0],
          [0, 1],
        ],
      ],
      { reversed: true },
    );
    const before = selections(editor),
      failure = new Error("Removal observer failed");
    const lease = editor.onDidRemoveSelection(() => {
      throw failure;
    });
    try {
      expect(() =>
        buffer.delete([
          [0, 0],
          [0, 1],
        ]),
      ).toThrow(failure);
      assertText(state, "xx", "observer rollback text");
      assertEqual(selections(editor), before, "observer rollback live selections");
    } finally {
      lease.dispose();
    }
    const events = [];
    const subscription = editor.onDidChangeSelectionRange((event) => events.push(event.selection));
    try {
      editor.setSelectedBufferRanges([
        [
          [0, 0],
          [0, 1],
        ],
        [
          [0, 1],
          [0, 2],
        ],
      ]);
      expect(events.every((selection) => editor.getSelections().includes(selection))).toBe(true);
      buffer.delete([
        [0, 0],
        [0, 1],
      ]);
      editor.undo();
      expect(editor.getSelections().length).toBe(2);
    } finally {
      subscription.dispose();
    }
  });

  for (const failed of [false, true])
    it(`finalizes coordinated replacement markers before their history snapshots, callback error=${failed}`, async () => {
      const states = [create("xx"), create("xx")];
      for (const { editor } of states)
        editor.setSelectedBufferRanges(
          [
            [
              [0, 1],
              [0, 2],
            ],
            [
              [0, 0],
              [0, 1],
            ],
          ],
          { reversed: true },
        );
      const before = states.map(({ editor }) => selections(editor));
      const plans = await Promise.all(
        states.map(({ buffer }) => buffer.prepareReplaceAllMatches(/^x/, "")),
      );
      const lease = failed
        ? require("../src/text-buffer-marker-finalizers").register(states[0].buffer, () => {
            throw Error("Coordinated marker observer failed");
          })
        : null;
      try {
        if (failed)
          expect(() => TextBuffer.commitPreparedReplacements(plans)).toThrow(
            jasmine.objectContaining({ committed: true, code: "ERR_REPLACE_OBSERVER_FAILED" }),
          );
        else expect(TextBuffer.commitPreparedReplacements(plans)).toBe(2);
      } finally {
        lease?.dispose();
      }
      for (let index = 0; index < states.length; index++) {
        const { editor, buffer } = states[index];
        assertText(states[index], "x", "coordinated source");
        const after = selections(editor);
        expect(after.length).toBe(1);
        expect(buffer.finalizingTransactionMarkers).toBe(false);
        editor.undo();
        assertText(states[index], "xx", "coordinated undo");
        assertEqual(selections(editor), before[index], "coordinated undo markers");
        editor.redo();
        assertEqual(selections(editor), after, "coordinated redo markers");
      }
    });

  for (const action of ["selection", "edit", "readOnly"])
    it(`does not publish a delayed native paste after ${action} changes`, async () => {
      const state = create("keep😀\r\nlast", true),
        gate = deferred();
      state.editor.setSelectedBufferRange([
        [1, 0],
        [1, 4],
      ]);
      clipboardBridge.readText.and.callFake((type) =>
        type === "selection" ? Promise.resolve("") : gate.promise,
      );
      const pending = state.editor.pasteText({ autoIndent: false, normalizeLineEndings: false });
      if (action === "selection") state.editor.setCursorBufferPosition([2, 2]);
      if (action === "edit") state.buffer.append("edited", { normalizeLineEndings: false });
      if (action === "readOnly") state.editor.setReadOnly(true);
      gate.resolve("must not paste");
      await pending;
      assertText(
        state,
        "keep😀\r\nlast" + (action === "edit" ? "edited" : ""),
        "stale native paste",
      );
    });

  for (const action of ["failure", "selection", "edit"])
    it(`preserves pending cuts after native ${action}`, async () => {
      const text = "left😀\r\nmid\rbare\nright",
        state = create(text, true);
      state.editor.setSelectedBufferRanges([
        [
          [1, 0],
          [1, 4],
        ],
        [
          [3, 0],
          [3, 5],
        ],
      ]);
      const before = selections(state.editor),
        gate = deferred();
      clipboardBridge.writeText.and.callFake((value, type) =>
        type === "selection"
          ? Promise.resolve()
          : gate.promise.then(() => {
              nativeText = value;
            }),
      );
      const pending = state.editor.cutSelectedText();
      assertText(state, text, "pending cut is not published");
      if (action === "failure") gate.reject(new Error("Native clipboard refused the write"));
      else {
        if (action === "selection") state.editor.setCursorBufferPosition([1, 2]);
        else state.buffer.append("!", { normalizeLineEndings: false });
        gate.resolve();
      }
      if (action === "failure") await expectAsync(pending).toBeRejectedWithError(/refused/);
      else await pending;
      assertText(
        state,
        text + (action === "edit" ? "!" : ""),
        "rejected/stale cut preserves source",
      );
      if (action === "failure")
        assertEqual(selections(state.editor), before, "failed cut selections");
      if (action !== "edit") expect(state.buffer.undo()).toBe(false);
    });

  it("refuses whole-document clipboard materialization before native writes and keeps undo usable", async () => {
    const state = create("tail😀\r\n", true);
    state.editor.selectAll();
    const before = selections(state.editor),
      snapshot = state.buffer.getTextSnapshot();
    expect(() => state.editor.copySelectedText()).toThrowError(/clipboard string limit/);
    expect(() => state.editor.cutSelectedText()).toThrowError(/clipboard string limit/);
    expect(writes).toEqual([]);
    expect(state.buffer.getTextSnapshot().equals(snapshot)).toBe(true);
    assertEqual(selections(state.editor), before, "clipboard refusal selections");
    state.editor.setCursorBufferPosition(state.buffer.getEndPosition());
    state.editor.insertText("new", { normalizeLineEndings: false });
    await command(state.editor, "core:undo");
    expect(state.buffer.getTextSnapshot().equals(snapshot)).toBe(true);
    await command(state.editor, "core:redo");
    assertText(state, "tail😀\r\nnew", "redo after refused clipboard operation");
  });

  for (const stale of [false, true])
    it(`keeps deferred paste indentation and undo exact, intervening edit=${stale}`, async () => {
      const state = create("head\n\noutside\n", true),
        { editor, buffer } = state;
      editor.setCursorBufferPosition([2, 0]);
      const before = selections(editor),
        gate = deferred(),
        started = deferred();
      const mode = buffer.getLanguageMode();
      mode.atTransactionEnd = () => Promise.resolve();
      mode.suggestedIndentForPastedRanges = () => {
        started.resolve();
        return gate.promise;
      };
      await clipboard.write("foo\nbar");
      const pending = editor.pasteText({ autoIndent: true, normalizeLineEndings: false });
      await started.promise;
      if (stale) {
        editor.setCursorBufferPosition(buffer.getEndPosition());
        editor.insertText("typed", { normalizeLineEndings: false });
      }
      gate.resolve(
        new Map([
          [2, 1],
          [3, 1],
        ]),
      );
      await pending;
      assertText(
        state,
        stale
          ? "head\nfoo\r\nbar\noutside\ntyped".replace(
              /\r\n/g,
              process.platform === "win32" ? "\r\n" : "\n",
            )
          : "head\n  foo" + (process.platform === "win32" ? "\r\n" : "\n") + "  bar\noutside\n",
        "deferred paste result",
      );
      if (stale) await command(editor, "core:undo");
      await command(editor, "core:undo");
      assertText(state, "head\n\noutside\n", "undo deferred paste");
      assertEqual(selections(editor), before, "deferred paste restores pre-paste cursor");
    });
});
