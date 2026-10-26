const TextEditor = require("../src/text-editor");
const TextBuffer = require("../src/text-buffer");
const { MAX_DOM_EXTENT } = require("../src/scroll-coordinate-space");

function random(seed) {
  return () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };
}
function repeatedSource(text, beyondStringLimit = false) {
  let source = TextBuffer.createTextSnapshot(text);
  if (beyondStringLimit)
    while (source.canMaterialize()) source = source.replace(source.length, source.length, source);
  return source;
}

describe("Large-document selection workflows", () => {
  let editors, steps, editCommands, started;
  beforeEach(() => {
    jasmine.useRealClock();
    editors = [];
    steps = 0;
    editCommands = 0;
    started = performance.now();
  });
  afterEach(() => {
    console.log(
      `SELECTION_WORKFLOW steps=${steps} editCommands=${editCommands} elapsedMs=${(performance.now() - started).toFixed(1)}`,
    );
    for (const editor of editors.reverse()) if (!editor.isDestroyed()) editor.destroy();
  });

  function mount(source, options = {}) {
    const editor = new TextEditor({
      buffer: new TextBuffer({ text: source }),
      autoHeight: false,
      softWrapped: false,
      ...options,
    });
    editors.push(editor);
    attach(editor);
    return editor;
  }
  function attach(editor, width = 720, height = 360) {
    const element = editor.getElement();
    element.style.width = `${width}px`;
    element.style.height = `${height}px`;
    jasmine.attachToDOM(element);
    element.getComponent().updateSync();
  }
  function refresh(editor, followCursor = true) {
    const component = editor.getElement().getComponent();
    component.updateSync();
    if (followCursor) editor.scrollToCursorPosition();
    component.updateSync();
    component.updateSync();
    return component;
  }
  function invariant(editor, label, { followCursor = true } = {}) {
    steps++;
    const component = refresh(editor, followCursor),
      element = editor.getElement();
    const viewport = component.refs.scrollContainer.getBoundingClientRect();
    const visible = (node) => {
      const box = node.getBoundingClientRect();
      return box.height > 0 && box.bottom > viewport.top && box.top < viewport.bottom;
    };
    for (const value of [
      component.getScrollTop(),
      component.getScrollLeft(),
      component.getScrollWidth(),
      component.getScrollHeight(),
    ])
      expect(Number.isFinite(value)).withContext(label).toBeTrue();
    const content = component.refs.content.getBoundingClientRect();
    expect(content.width)
      .withContext(label)
      .toBeLessThanOrEqual(MAX_DOM_EXTENT + 1);
    expect(content.height)
      .withContext(label)
      .toBeLessThanOrEqual(MAX_DOM_EXTENT + 1);
    const lines = [...element.querySelectorAll(".line[data-screen-row]")].filter(
      (node) => !node.classList.contains("dummy"),
    );
    const gutter = [...element.querySelectorAll(".line-number[data-screen-row]")].filter(
      (node) => !node.classList.contains("dummy"),
    );
    expect(lines.length).withContext(label).toBeLessThan(500);
    expect(gutter.length).withContext(label).toBeLessThan(500);
    expect(lines.some(visible)).withContext(label).toBeTrue();
    expect(gutter.some(visible)).withContext(label).toBeTrue();
    for (const node of gutter.filter(visible)) {
      const row = Number(node.dataset.screenRow);
      expect(Number(node.dataset.bufferRow))
        .withContext(`${label}: gutter ${row}`)
        .toBe(editor.bufferPositionForScreenPosition([row, 0]).row);
    }
    for (const cursor of editor.getCursors()) {
      const buffer = cursor.getBufferPosition();
      const screen = editor.screenPositionForBufferPosition(buffer);
      const canonical = editor.bufferPositionForScreenPosition(screen);
      expect(editor.screenPositionForBufferPosition(canonical).serialize())
        .withContext(`${label}: position idempotence`)
        .toEqual(screen.serialize());
      expect(Number.isFinite(screen.row) && Number.isFinite(screen.column))
        .withContext(label)
        .toBeTrue();
    }
    if (followCursor && editor.getCursors().length === 1) {
      expect(visible(component.refs.cursorsAndInput.refs.hiddenInput))
        .withContext(`${label}: input anchor`)
        .toBeTrue();
      const cursorRow = editor.getCursorScreenPosition().row;
      expect(lines.some((node) => Number(node.dataset.screenRow) === cursorRow && visible(node)))
        .withContext(`${label}: cursor line`)
        .toBeTrue();
    }
    return component;
  }
  async function insertAndRestore(editor, text, label, insert) {
    const buffer = editor.getBuffer(),
      before = buffer.getTextSnapshot();
    buffer.clearUndoStack();
    const selected = editor.getSelectedBufferRanges();
    let expected = before;
    for (const range of selected.slice().sort((a, b) => b.start.compare(a.start))) {
      const start = buffer.characterIndexForPosition(range.start),
        end = buffer.characterIndexForPosition(range.end);
      expected = expected.replace(start, end, text);
    }
    editCommands++;
    await (insert
      ? insert()
      : editor.insertText(text, { autoIndent: false, normalizeLineEndings: false }));
    expect(buffer.getTextSnapshot().equals(expected))
      .withContext(`${label}: exact edit`)
      .toBeTrue();
    invariant(editor, `${label}: typed`);
    editCommands++;
    await editor.undo();
    expect(buffer.getTextSnapshot().equals(before)).withContext(`${label}: undo source`).toBeTrue();
    invariant(editor, `${label}: undo`);
    editCommands++;
    await editor.redo();
    expect(buffer.getTextSnapshot().equals(expected))
      .withContext(`${label}: redo source`)
      .toBeTrue();
    invariant(editor, `${label}: redo`);
    editCommands++;
    await editor.undo();
    expect(buffer.getTextSnapshot().equals(before))
      .withContext(`${label}: final source`)
      .toBeTrue();
  }

  it("runs seeded Ctrl-End, backward/empty selection, typing and scrolling on shared CRLF/Unicode rows beyond the string limit", async () => {
    const source = repeatedSource(
      "\talpha 😀 é 界\r\nbeta\t👩‍🔬 gamma\r\nlast-word\r\n".repeat(1024),
      true,
    );
    const editor = mount(source),
      buffer = editor.getBuffer();
    expect(source.canMaterialize()).toBeFalse();
    const next = random(0x1a2b3c4d);
    for (let index = 0; index < 24; index++) {
      const row =
        index % 4 === 0
          ? buffer.getLastRow() - 1
          : index % 4 === 1
            ? 0
            : Math.floor(next() * (buffer.getLineCount() - 1));
      editor.setCursorBufferPosition([row, 0]);
      if (index % 6 === 0) editor.moveToBottom();
      else if (index % 6 === 1)
        editor.setSelectedBufferRange(
          [
            [row, 0],
            [row, 3],
          ],
          { reversed: true },
        );
      else if (index % 6 === 2) await editor.moveToBeginningOfNextWord();
      else if (index % 6 === 3) {
        await editor.selectToEndOfWord();
        await editor.moveToPreviousWordBoundary();
      } else if (index % 6 === 4)
        editor.setSelectedBufferRange(
          [
            [row, 0],
            [row, 0],
          ],
          { reversed: true },
        );
      else editor.moveToEndOfLine();
      invariant(editor, `dense seed step ${index}`);
      if (index % 4 === 0) await insertAndRestore(editor, "Z", `dense seed edit ${index}`);
      if (index % 4 === 1) {
        const component = editor.getElement().getComponent();
        component.setScrollTop(index % 8 === 1 ? 0 : component.getMaxScrollTop());
        invariant(editor, `dense scroll boundary ${index}`, { followCursor: false });
      }
    }
    buffer.setPreferredLineEnding("\r\n");
    editor.moveToBottom();
    await insertAndRestore(editor, "\r\n", "Ctrl-End then Enter", () =>
      editor.insertNewline({ autoIndent: false }),
    );
    expect(buffer.getTextSnapshot().equals(source)).toBeTrue();
    expect(steps).toBeGreaterThanOrEqual(51);
  }, 60000);

  it("keeps a giant shared row editable at horizontal boundaries after backward and multiple selections", async () => {
    const source = repeatedSource("alpha beta ".repeat(4096), true);
    const editor = mount(source),
      buffer = editor.getBuffer(),
      length = source.length;
    const next = random(0x0badcafe);
    spyOn(buffer, "lineForRow").and.throwError("workflow materialized giant row");
    for (let index = 0; index < 18; index++) {
      const column = index % 3 === 0 ? length : index % 3 === 1 ? 0 : Math.floor(next() * length);
      editor.setCursorBufferPosition([0, column]);
      await editor.moveToPreviousWordBoundary();
      invariant(editor, `giant row movement ${index}`);
      if (index % 3 === 0) {
        editor.setSelectedBufferRange(
          [
            [0, length - 5],
            [0, length],
          ],
          { reversed: true },
        );
        expect(editor.getLastSelection().isReversed()).toBeTrue();
        await insertAndRestore(editor, "Q", `giant row backward edit ${index}`);
      }
      if (index % 3 === 1) {
        editor.setSelectedBufferRanges([
          [
            [0, 1],
            [0, 1],
          ],
          [
            [0, Math.floor(length / 2)],
            [0, Math.floor(length / 2)],
          ],
          [
            [0, length - 1],
            [0, length - 1],
          ],
        ]);
        await insertAndRestore(editor, "!", `giant row multi edit ${index}`);
      }
    }
    expect(buffer.getTextSnapshot().equals(source)).toBeTrue();
    expect(steps).toBeGreaterThanOrEqual(54);
  }, 60000);

  it("preserves independent split folds and wrapping through seeded resize and undo/redo", async () => {
    const text = ("\titem 😀 é 界 words ".repeat(18) + "\r\n").repeat(1200) + "tail";
    const first = mount(TextBuffer.createTextSnapshot(text), { softWrapped: true });
    first.setSoftWrapped(true);
    const second = first.copy();
    editors.push(second);
    attach(second, 540, 280);
    second.setSoftWrapped(false);
    first.foldBufferRange([
      [150, 3],
      [350, 4],
    ]);
    second.foldBufferRange([
      [500, 2],
      [950, 5],
    ]);
    const next = random(0x31415926);
    for (let index = 0; index < 20; index++) {
      const row = index % 2 ? 1100 + Math.floor(next() * 90) : Math.floor(next() * 100);
      const selected = index % 2 ? first : second;
      selected.setCursorBufferPosition([row, index % 2 ? 10 : 0]);
      const element = selected.getElement();
      element.style.width = `${320 + Math.floor(next() * 540)}px`;
      element.style.height = `${180 + Math.floor(next() * 220)}px`;
      if (index % 5 === 0) {
        first.setSoftWrapped(false);
        first.setSoftWrapped(true);
      }
      // Let ResizeObserver invalidate cached dimensions before requesting
      // cursor reveal against the resized viewport.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      invariant(first, `wrapped split ${index}`);
      invariant(second, `unwrapped split ${index}`);
      if (index % 4 === 0) {
        await insertAndRestore(selected, index % 8 === 0 ? "X\r\n" : "X", `split edit ${index}`);
        invariant(selected === first ? second : first, `split peer after edit ${index}`);
      }
    }
    expect(
      first.getBuffer().getTextSnapshot().equals(TextBuffer.createTextSnapshot(text)),
    ).toBeTrue();
    expect(first.isSoftWrapped()).toBeTrue();
    expect(second.isSoftWrapped()).toBeFalse();
    expect(first.displayLayer.foldsMarkerLayer.getMarkerCount()).toBe(1);
    expect(second.displayLayer.foldsMarkerLayer.getMarkerCount()).toBe(1);
  }, 60000);

  it("retains cursor and selection geometry on a Unicode horizontal window across line splitting and joining by history", async () => {
    const source = TextBuffer.createTextSnapshot(
      "head\r\n" + "界😀á\t👩‍🔬 word ".repeat(12000) + "\r\nend",
    );
    const editor = mount(source),
      buffer = editor.getBuffer();
    buffer.setPreferredLineEnding("\r\n");
    for (const column of [0, 30000, 90000, buffer.lineLengthForRow(1)]) {
      editor.setCursorBufferPosition([1, column]);
      invariant(editor, `Unicode window ${column}`);
      const before = buffer.getTextSnapshot();
      buffer.clearUndoStack();
      editCommands++;
      await editor.insertNewline({ autoIndent: false });
      invariant(editor, `Unicode newline ${column}`);
      expect(buffer.getLineCount()).toBe(4);
      editCommands++;
      await editor.undo();
      invariant(editor, `Unicode newline undo ${column}`);
      expect(buffer.getTextSnapshot().equals(before)).toBeTrue();
      editCommands++;
      await editor.redo();
      invariant(editor, `Unicode newline redo ${column}`);
      editCommands++;
      await editor.undo();
    }
    expect(buffer.getTextSnapshot().equals(source)).toBeTrue();
  }, 60000);
  it("isolates one-character edits on an unchanged giant row", () => {
    const source = repeatedSource("alpha beta ".repeat(4096), true);
    const standalone = new TextBuffer({ text: source });
    const bare = new TextEditor({
      buffer: new TextBuffer({ text: source }),
      autoHeight: false,
      softWrapped: false,
    });
    editors.push(bare);
    const mounted = mount(source);
    const prototype = Object.getPrototypeOf(source),
      originalReader = prototype.reader,
      originalSlice = prototype.slice;
    let readUnits = 0,
      sliceUnits = 0;
    spyOn(prototype, "reader").and.callFake(function (...args) {
      const reader = originalReader.apply(this, args);

      return (offset) => {
        const value = reader(offset);
        readUnits += value.length;
        return value;
      };
    });
    spyOn(prototype, "slice").and.callFake(function (...args) {
      const value = originalSlice.apply(this, args);
      sliceUnits += value.length;
      return value;
    });
    for (const [name, buffer] of [
      ["buffer", standalone],
      ["editor", bare.getBuffer()],
      ["mounted", mounted.getBuffer()],
    ]) {
      readUnits = sliceUnits = 0;

      const start = performance.now();
      editCommands++;
      buffer.setTextInRange(
        [
          [0, source.length - 1],
          [0, source.length],
        ],
        "Q",
      );
      console.log(
        `ONE_CHARACTER_EDIT ${name} ${(performance.now() - start).toFixed(1)}ms readUnits=${readUnits} sliceUnits=${sliceUnits}`,
      );
      if (name === "mounted") {
        expect(readUnits).toBeLessThan(1048576);
        expect(sliceUnits).toBeLessThan(1048576);
      }
      expect(buffer.getTextSnapshot().slice(source.length - 1)).toBe("Q");
    }
    standalone.destroy();
  }, 60000);
  it("keeps giant Unicode/tab rows bounded and preserves copied-window pixel geometry", async () => {
    const source = repeatedSource("Z\t界😀 é 👩‍🔬 tail ".repeat(2048), true);
    const editor = mount(source);
    for (const column of [source.length, Math.floor(source.length / 2), 0]) {
      editor.setCursorBufferPosition([0, column]);
      invariant(editor, `giant Unicode/tab ${column}`);
      await insertAndRestore(editor, "Q", `giant Unicode/tab edit ${column}`);
    }
    const unit = "Z\t界😀 é 👩‍🔬 tail ".length;
    editor.foldBufferRange([
      [0, unit * 20],
      [0, source.length - unit * 20],
    ]);
    editor.setCursorBufferPosition([0, source.length - unit]);
    invariant(editor, "giant Unicode fold tail");
    await insertAndRestore(editor, "!", "giant Unicode folded edit");
    const layer = editor.getBuffer().addDisplayLayer({ softWrapColumn: Infinity });
    let copy;
    try {
      const window = layer.getScreenLineWindow(0, 0, 100);
      copy = layer.copy();
      expect(copy.getScreenLineWindow(0, 0, 100).lineText).toBe(window.lineText);
      expect(copy.pixelColumnForScreenColumn(0, 80)).toBe(layer.pixelColumnForScreenColumn(0, 80));
      expect(copy.screenColumnForPixelColumn(0, 80)).toBe(layer.screenColumnForPixelColumn(0, 80));
    } finally {
      copy?.destroy();
      layer.destroy();
    }
  }, 60000);
  it("keeps inverse pixel columns independent of snapshot topology and fold boundaries", () => {
    const { PieceTree } = require("../src/text-model");
    const examples = [
      "a\u0301b",
      "\u0301b",
      "a\u0301\u0301b",
      "a\u200d\u0301b",
      "👩‍🔬x",
      "ab\t\u0301c",
      "\t\u0301\tb",
      "a\ufe0fb",
    ];
    for (const text of examples) {
      const buffer = new TextBuffer(text);
      const layer = buffer.addDisplayLayer({ softWrapColumn: Infinity });
      try {
        layer.getScreenLines(0, 1);
        const length = layer.getUnwrappedRowPixelGeometry(0).pixelLength;
        const targets = [
          0,
          0.25,
          ...Array.from({ length: Math.ceil(length) + 1 }, (_, index) => index),
          length + 0.5,
          Infinity,
        ];
        const expected = targets.map((pixel) => layer.screenColumnForPixelColumn(0, pixel));
        for (let cut = 1; cut < text.length; cut++) {
          const source = PieceTree.fromSnapshotNode(
            undefined,
            new PieceTree(text.slice(0, cut)),
            new PieceTree(text.slice(cut)),
          );
          buffer.setText(source);
          layer.getScreenLines(0, 1);
          expect(targets.map((pixel) => layer.screenColumnForPixelColumn(0, pixel)))
            .withContext(JSON.stringify({ text, cut }))
            .toEqual(expected);
        }
      } finally {
        buffer.destroy();
      }
    }
    const buffer = new TextBuffer("a\u0301hidden\nb");
    const layer = buffer.addDisplayLayer({ softWrapColumn: Infinity });
    try {
      layer.foldBufferRange([
        [0, 2],
        [1, 0],
      ]);
      expect(layer.getScreenLineWindow(0, 0, 10).lineText).toBe("a\u0301⋯b");
      expect(layer.screenColumnForPixelColumn(0, 1)).toBe(1);
    } finally {
      buffer.destroy();
    }
  });
  it("measures a surrogate after a fold using the visible fold character as predecessor", () => {
    const buffer = new TextBuffer("aX\nY\ud83d\ude00\tb");
    const layer = buffer.addDisplayLayer({ softWrapColumn: Infinity });
    let reference;
    try {
      layer.foldBufferRange([
        [0, 1],
        [1, 2],
      ]);
      const text = layer.getScreenLineWindow(0, 0, 10).lineText;
      expect(text).toBe("a⋯\ude00 b");
      reference = new TextBuffer(text);
      const plain = reference.addDisplayLayer({ softWrapColumn: Infinity });
      plain.getScreenLines(0, 1);
      expect(layer.getUnwrappedRowPixelGeometry(0).pixelLength).toBe(5);
      for (let pixel = 0; pixel <= 5.5; pixel += 0.5)
        expect(layer.screenColumnForPixelColumn(0, pixel))
          .withContext(`pixel ${pixel}`)
          .toBe(plain.screenColumnForPixelColumn(0, pixel));
    } finally {
      reference?.destroy();
      buffer.destroy();
    }
  });
});
