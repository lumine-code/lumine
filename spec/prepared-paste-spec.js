const Service = require("../src/syntax-worker-service");
const WorkerMode = require("../src/tree-sitter-worker-language-mode");
const { PieceTree } = require("../src/text-model");

describe("Prepared paste publication", () => {
  let editor, service;
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const clipboard = (text, metadata) => ({ readWithMetadata: () => ({ text, metadata }) });
  const ranges = () =>
    editor
      .getSelections()
      .map((s) => ({ range: s.getBufferRange().serialize(), reversed: s.isReversed() }));
  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-tasklist");
    await lumine.packages.activatePackage("language-javascript");
    editor = await lumine.workspace.open();
    editor.update({ tabLength: 2, softTabs: true, autoIndent: true });
    service = new Service(lumine.grammars);
  });
  afterEach(() => {
    editor?.destroy();
    service?.dispose();
  });
  async function start(text, scope = "text.tasklist") {
    editor.setText(text);
    editor.getBuffer().setLanguageMode(
      new WorkerMode({
        buffer: editor.getBuffer(),
        grammar: lumine.grammars.grammarForScopeName(scope),
        service,
      }),
    );
    await editor.whenGrammarSettled();
    editor.getBuffer().clearUndoStack();
    return editor.getBuffer().getLanguageMode();
  }
  function holdReply() {
    let enter, release;
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const request = service.client.request.bind(service.client);
    const calls = [];
    spyOn(service.client, "request").and.callFake((operation, data, options = {}) => {
      calls.push({ operation, data });
      const result = request(operation, data, options);
      if (operation !== "prepared-indent") return result;
      enter();
      const delayed = new Promise((resolve, reject) => {
        const abort = () => reject(options.signal.reason);
        options.signal.addEventListener("abort", abort, { once: true });
        gate.then(resolve).finally(() => options.signal.removeEventListener("abort", abort));
        if (options.signal.aborted) abort();
      });
      return Promise.all([result, delayed]).then(([value]) => value);
    });
    return { entered, release, calls };
  }

  it("keeps every waiting frame unchanged, then paints only final Tasklist indentation", async () => {
    const original = "Wstęp\n".repeat(19) + "Projekt:\n  ☐ zadanie\n\nKoniec:\n";
    const text = "Nowy projekt:\n  ☐ rozliczenie";
    await start(original);
    editor.setCursorBufferPosition([21, 0]);
    editor.scrollToCursorPosition({ mode: "center" });
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    const element = editor.getElement();
    element.focus();
    await frame();
    await frame();
    const before = ranges(),
      events = [],
      publications = [];
    editor.onDidInsertText((event) =>
      events.push({ text: event.text, observed: editor.getTextInBufferRange(event.range) }),
    );
    editor.getBuffer().onDidApplyChanges(() => publications.push(editor.getText()));
    const hold = holdReply();
    const pending = editor.pasteText({ clipboard: clipboard(text) });
    try {
      await hold.entered;
      for (let i = 0; i < 5; i++) {
        await frame();
        expect(editor.getText()).toBe(original);
        expect(ranges()).toEqual(before);
        expect(element.textContent.includes("Nowy projekt:")).toBe(false);
        expect(events).toEqual([]);
        expect(publications).toEqual([]);
      }
    } finally {
      hold.release();
    }
    await pending;
    const expected =
      "Wstęp\n".repeat(19) + "Projekt:\n  ☐ zadanie\n  Nowy projekt:\n    ☐ rozliczenie\nKoniec:\n";
    expect(editor.getText()).toBe(expected);
    expect(publications).toEqual([expected]);
    expect(events).toEqual([
      {
        text: "  Nowy projekt:\n    ☐ rozliczenie",
        observed: "  Nowy projekt:\n    ☐ rozliczenie",
      },
    ]);
    let painted = false;
    for (let i = 0; i < 5; i++) {
      await frame();
      const line = element.querySelector('.line[data-screen-row="21"]');
      if (line?.textContent.includes("Nowy projekt:")) {
        painted = true;
        expect(line.textContent.startsWith("  Nowy projekt:")).toBe(true);
        expect(
          element
            .querySelector('.line[data-screen-row="22"]')
            .textContent.startsWith("    ☐ rozliczenie"),
        ).toBe(true);
      }
    }
    expect(painted).toBe(true);
    const after = ranges();
    editor.undo();
    expect(editor.getText()).toBe(original);
    expect(ranges()).toEqual(before);
    editor.redo();
    expect(editor.getText()).toBe(expected);
    expect(ranges()).toEqual(after);
  });

  for (const count of [1, 8, 128])
    it(`publishes ${count} distributed reversed selections as one undo operation`, async () => {
      const original = "function work() {\n  old();\n}\n".repeat(count);
      await start(original, "source.js");
      editor.setSelectedBufferRanges(
        Array.from({ length: count }, (_, i) => [
          [i * 3 + 1, 2],
          [i * 3 + 1, 8],
        ]).reverse(),
      );
      for (const selection of editor.getSelections())
        selection.setBufferRange(selection.getBufferRange(), { reversed: true });
      const before = ranges();
      let publications = 0;
      editor.getBuffer().onDidApplyChanges(() => publications++);
      await editor.pasteText({ select: true, clipboard: clipboard("value();\nnext();") });
      const expected = "function work() {\n  value();\n  next();\n}\n".repeat(count);
      expect(editor.getText()).toBe(expected);
      expect(publications).toBe(1);
      expect(editor.getSelections().length).toBe(count);
      const after = ranges();
      editor.undo();
      expect(editor.getText()).toBe(original);
      expect(ranges()).toEqual(before);
      editor.redo();
      expect(editor.getText()).toBe(expected);
      expect(ranges()).toEqual(after);
    });

  for (const action of [
    "edit",
    "selection",
    "reverse",
    "grammar",
    "tabLength",
    "softTabs",
    "readOnly",
    "destroy",
    "abort",
  ])
    it(`cancels preparation after ${action} without publishing paste or insertion events`, async () => {
      const original = "Projekt:\n  ☐ zadanie\n\n";
      await start(original);
      editor.setCursorBufferPosition([2, 0]);
      let events = 0;
      editor.onDidInsertText(() => events++);
      const hold = holdReply(),
        controller = new AbortController();
      const pending = editor.pasteText({
        signal: controller.signal,
        clipboard: clipboard("Nowy:\n  ☐ wpis"),
      });
      await hold.entered;
      if (action === "edit") editor.getBuffer().append("external");
      if (action === "selection") editor.setCursorBufferPosition([0, 0]);
      if (action === "reverse") {
        editor.setSelectedBufferRange(
          [
            [0, 0],
            [1, 0],
          ],
          { reversed: true },
        );
        editor.setCursorBufferPosition([2, 0]);
      }
      if (action === "grammar")
        lumine.grammars.assignLanguageMode(editor.getBuffer(), "text.plain.null-grammar");
      if (action === "tabLength") {
        editor.setTabLength(4);
        editor.setTabLength(2);
      }
      if (action === "softTabs") {
        editor.setSoftTabs(false);
        editor.setSoftTabs(true);
      }
      if (action === "readOnly") editor.setReadOnly(true);
      if (action === "destroy") editor.destroy();
      if (action === "abort") controller.abort();
      try {
        expect(await pending).toBe(false);
      } finally {
        hold.release();
      }
      expect(events).toBe(0);
      if (action !== "destroy")
        expect(editor.getText()).toBe(original + (action === "edit" ? "external" : ""));
    });

  it("leaves text, selections and history intact when candidate analysis fails", async () => {
    const original = "Projekt:\n  ☐ zadanie\n\n";
    const mode = await start(original);
    editor.setCursorBufferPosition([2, 0]);
    const before = ranges(),
      failure = new Error("candidate indentation failure");
    spyOn(mode, "scanPreparedIndentation").and.callFake(() =>
      (async function* () {
        yield Promise.reject(failure);
      })(),
    );
    let events = 0;
    editor.onDidInsertText(() => events++);
    await expectAsync(
      editor.pasteText({ clipboard: clipboard("Nowy:\n  ☐ wpis") }),
    ).toBeRejectedWith(failure);
    expect(editor.getText()).toBe(original);
    expect(ranges()).toEqual(before);
    expect(events).toBe(0);
    expect(editor.hasPendingIndentation()).toBe(false);
    editor.undo();
    expect(editor.getText()).toBe(original);
  });

  it("keeps an identical replacement's cursor result even when no text edit is needed", async () => {
    const original = "Projekt:\n  wpis\n  dalej\n";
    await start(original);
    editor.setSelectedBufferRange([
      [1, 2],
      [2, 7],
    ]);
    await editor.pasteText({ clipboard: clipboard("wpis\ndalej") });
    expect(editor.getText()).toBe(original);
    expect(editor.getSelectedBufferRange().isEmpty()).toBe(true);
    expect(editor.getCursorBufferPosition().serialize()).toEqual([2, 7]);
  });

  it("preserves full-line metadata and distributed Unicode text with CRLF and hard tabs", async () => {
    const original = "function a() {\r\n\tfirst();\r\n}\r\nfunction b() {\r\n\tsecond();\r\n}\r\n";
    await start(original, "source.js");
    editor.setSoftTabs(false);
    editor.setSelectedBufferRanges([
      [
        [1, 3],
        [1, 3],
      ],
      [
        [4, 4],
        [4, 4],
      ],
    ]);
    const before = ranges();
    await editor.pasteText({
      clipboard: clipboard("ignored", {
        selections: [
          { text: "// 🦉\nnext();\n", fullLine: true, indentBasis: 0 },
          { text: "// café\nlast();\n", fullLine: true, indentBasis: 0 },
        ],
      }),
    });
    expect(editor.getText()).toBe(
      "function a() {\r\n\t// 🦉\r\n\tnext();\r\n\tfirst();\r\n}\r\nfunction b() {\r\n\t// café\r\n\tlast();\r\n\tsecond();\r\n}\r\n",
    );
    const after = ranges();
    editor.undo();
    expect(editor.getText()).toBe(original);
    expect(ranges()).toEqual(before);
    editor.redo();
    expect(ranges()).toEqual(after);
  });

  for (const count of [3, 128])
    it(`shares a document beyond the string limit while preparing ${count} distant cursors`, async () => {
      const mode = editor.getBuffer().getLanguageMode();
      let source = new PieceTree("x\n".repeat(32768));
      while (source.length <= require("node:buffer").constants.MAX_STRING_LENGTH)
        source = source.replace(source.length, source.length, source);
      editor.getBuffer().setText(source);
      editor.getBuffer().clearUndoStack();
      const rows = Array.from({ length: count }, (_, i) =>
        Math.floor((i * (source.lineCount - 1)) / (count - 1)),
      );
      editor.setSelectedBufferRanges(
        rows.map((row) => [
          [row, 0],
          [row, 0],
        ]),
      );
      mode.scanPreparedIndentation = async function* (changes, ranges) {
        expect(changes.length).toBe(count);
        expect(changes.every((change) => change.newTextSource.length === 4)).toBe(true);
        for (const [start, end] of ranges) {
          const batch = [];
          for (let row = start; row <= end; row++) batch.push([row, 1]);
          yield batch;
        }
      };
      const materialize = PieceTree.prototype.toString,
        reads = [];
      spyOn(PieceTree.prototype, "toString").and.callFake(function () {
        reads.push(this.length);
        if (this.length > 65536) throw new Error("whole source materialized");
        return materialize.call(this);
      });
      const before = ranges();
      await editor.pasteText({ clipboard: clipboard("a\nb\n") });
      expect(reads.every((length) => length <= 65536)).toBe(true);
      expect(editor.getBuffer().getLength()).toBe(source.length + count * 8);
      const after = editor.getBuffer().getTextSnapshot(),
        afterRanges = ranges();
      editor.undo();
      expect(editor.getBuffer().getTextSnapshot().equals(source)).toBe(true);
      expect(ranges()).toEqual(before);
      editor.redo();
      expect(editor.getBuffer().getTextSnapshot().equals(after)).toBe(true);
      expect(ranges()).toEqual(afterRanges);
    });

  it("uses the inserted closing delimiter when resolving the first pasted row", async () => {
    await start("if (ready) {\n  \n}\n", "source.js");
    editor.setCursorBufferPosition([1, 2]);
    await editor.pasteText({ clipboard: clipboard("} else {\n  call();") });
    expect(editor.getText()).toBe("if (ready) {\n} else {\n  call();\n}\n");
  });

  it("preserves the parent language and parses injected JavaScript in a private candidate", async () => {
    await lumine.packages.activatePackage("language-html");
    await start("<script>\nfunction work() {\n\n}\n</script>\n", "text.html.basic");
    editor.setCursorBufferPosition([2, 0]);
    await editor.pasteText({ clipboard: clipboard("value();\nnext();") });
    expect(editor.getText()).toBe(
      "<script>\nfunction work() {\n  value();\n  next();\n}\n</script>\n",
    );
  });

  it("streams a large multiline insertion and publishes it only once", async () => {
    const original = "function work() {\n\n}\n";
    await start(original, "source.js");
    editor.setCursorBufferPosition([1, 0]);
    const text = "value();\n".repeat(12000),
      expected = "function work() {\n" + "  value();\n".repeat(12000) + "\n}\n";
    const calls = [],
      request = service.client.request.bind(service.client);
    spyOn(service.client, "request").and.callFake((operation, data, options) => {
      calls.push({ operation, length: data.text?.length });
      return request(operation, data, options);
    });
    let publications = 0;
    editor.getBuffer().onDidApplyChanges(() => publications++);
    await editor.pasteText({ clipboard: clipboard(text) });
    expect(editor.getText()).toBe(expected);
    expect(publications).toBe(1);
    expect(calls.some((c) => c.operation === "edit-text-chunk")).toBe(true);
    expect(calls.filter((c) => c.length !== undefined).every((c) => c.length <= 65536)).toBe(true);
    expect(calls.some((c) => c.operation === "open" || c.operation === "append")).toBe(false);
    editor.undo();
    expect(editor.getText()).toBe(original);
    editor.redo();
    expect(editor.getText()).toBe(expected);
  }, 20000);

  it("moves a Tasklist header from row 23 to 22 with final indentation in the first changed frame", async () => {
    const prefix = "Wstęp\n".repeat(19);
    const original = prefix + "Projekt:\n  ☐ zadanie\n\nKolejny projekt:\n  ☐ następne\n";
    const expected = prefix + "Projekt:\n  ☐ zadanie\n  Kolejny projekt:\n\n  ☐ następne\n";
    const mode = await start(original);
    editor.setCursorBufferPosition([22, 0]);
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    editor.scrollToCursorPosition({ mode: "center" });
    mode.requestHighlighting(editor, [[19, 24]]);
    await mode.refresh();
    const roles = (row) =>
      editor
        .tokensForScreenRow(row, { highlightingOwner: editor })
        .flatMap((token) => Array.from(token.text, () => token.scopes));
    const colors = roles(22);
    expect(colors.some((scopes) => scopes.length > 1)).toBe(true);
    const refresh = spyOn(mode, "refresh").and.callFake(async () => {});
    await frame();
    await frame();
    const before = ranges(),
      publications = [];
    editor.getBuffer().onDidApplyChanges(() => publications.push(editor.getText()));
    const hold = holdReply(),
      moving = editor.moveLineUp();
    try {
      await hold.entered;
      for (let i = 0; i < 5; i++) {
        await frame();
        expect(editor.getText()).toBe(original);
        expect(ranges()).toEqual(before);
        expect(
          editor.getElement().querySelector('.line[data-screen-row="22"]').textContent,
        ).toContain("Kolejny projekt:");
        expect(publications).toEqual([]);
      }
    } finally {
      hold.release();
    }
    await moving;
    expect(editor.getText()).toBe(expected);
    expect(publications).toEqual([expected]);
    expect(roles(21).slice(2)).toEqual(colors);
    for (let i = 0; i < 5; i++) {
      await frame();
      const target = editor.getElement().querySelector('.line[data-screen-row="21"]');
      if (target.textContent.includes("Kolejny projekt:"))
        expect(target.textContent.startsWith("  Kolejny projekt:")).toBe(true);
      expect(roles(21).slice(2)).toEqual(colors);
    }
    const after = ranges();
    editor.undo();
    expect(editor.getText()).toBe(original);
    expect(ranges()).toEqual(before);
    expect(roles(22)).toEqual(colors);
    editor.redo();
    expect(editor.getText()).toBe(expected);
    expect(ranges()).toEqual(after);
    expect(roles(21).slice(2)).toEqual(colors);
    refresh.and.callThrough();
  });

  for (const command of ["moveLineUp", "moveLineDown"])
    it(`keeps folded blocks and multiple cursors through prepared ${command} and history`, async () => {
      const original = "one\nif (first) {\n  work();\n}\ntwo\nif (second) {\n  next();\n}\nlast\n";
      await start(original, "source.js");
      editor.foldBufferRange([
        [1, 12],
        [3, 0],
      ]);
      editor.foldBufferRange([
        [5, 13],
        [7, 0],
      ]);
      editor.setSelectedBufferRanges(
        [
          [
            [5, 0],
            [5, 0],
          ],
          [
            [1, 0],
            [1, 0],
          ],
        ],
        { preserveFolds: true },
      );
      const before = ranges(),
        folds = () =>
          editor.displayLayer.foldsMarkerLayer
            .getMarkers()
            .map((m) => m.getRange().serialize())
            .sort();
      const beforeFolds = folds();
      await editor[command]();
      const text = editor.getText(),
        after = ranges(),
        afterFolds = folds();
      expect(after.length).toBe(2);
      expect(after.map((selection) => selection.range[0][0])).toEqual(
        command === "moveLineUp" ? [4, 0] : [6, 2],
      );
      expect(afterFolds.length).toBe(2);
      expect(text).not.toBe(original);
      editor.undo();
      expect(editor.getText()).toBe(original);
      expect(ranges()).toEqual(before);
      expect(folds()).toEqual(beforeFolds);
      editor.redo();
      expect(editor.getText()).toBe(text);
      expect(ranges()).toEqual(after);
      expect(folds()).toEqual(afterFolds);
    });

  it("queues repeated move commands while syntax is pending instead of discarding key repeats", async () => {
    const original = "first\nsecond\nthird\nlast\n";
    await start(original);
    editor.setCursorBufferPosition([3, 0]);
    const hold = holdReply(),
      first = editor.moveLineUp();
    await hold.entered;
    const second = editor.moveLineUp();
    hold.release();
    await Promise.all([first, second]);
    expect(editor.getText()).toBe("first\nlast\nsecond\nthird\n");
    editor.undo();
    expect(editor.getText()).toBe("first\nsecond\nlast\nthird\n");
    editor.undo();
    expect(editor.getText()).toBe(original);
  });

  it("records cursor history when moving identical lines leaves text unchanged", async () => {
    const original = "same\nsame\nsame\n";
    await start(original);
    editor.setCursorBufferPosition([2, 1]);
    await editor.moveLineUp();
    expect(editor.getText()).toBe(original);
    expect(editor.getCursorBufferPosition().serialize()).toEqual([1, 1]);
    editor.undo();
    expect(editor.getCursorBufferPosition().serialize()).toEqual([2, 1]);
    editor.redo();
    expect(editor.getCursorBufferPosition().serialize()).toEqual([1, 1]);
  });
});
