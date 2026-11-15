const path = require("node:path");
const dispatchInput = require("../src/text-editor-input-queue");

const fixtures = [
  {
    name: "identifier conditions",
    source: "if ready: first()\nelif other: second()\nelse: third()",
    bodies: ["first()", "second()", "third()"],
  },
  {
    name: "comparison conditions",
    source: "if value < 1: first()\nelif value < 2: second()\nelse: third()",
    bodies: ["first()", "second()", "third()"],
  },
  {
    name: "lambda conditions",
    source:
      "if (lambda n: n > 0)(value): first()\nelif (lambda n: n == 0)(value): second()\nelse: third()",
    bodies: ["first()", "second()", "third()"],
  },
  {
    name: "dictionary and slice conditions",
    source: 'if {"x": flag}["x"]: first()\nelif values[1:]: second()\nelse: third()',
    bodies: ["first()", "second()", "third()"],
  },
  {
    name: "try, except and finally",
    source: "try: first()\nexcept ValueError: second()\nfinally: third()",
    bodies: ["first()", "second()", "third()"],
  },
  {
    name: "for and else",
    source: "for value in values: first()\nelse: second()",
    bodies: ["first()", "second()"],
  },
  {
    name: "while and else",
    source: "while ready: first()\nelse: second()",
    bodies: ["first()", "second()"],
  },
  {
    name: "nested branches",
    source: "def outer():\n    if ready: first()\n    elif other: second()\n    else: third()",
    bodies: ["first()", "second()", "third()"],
    columns: 8,
  },
  {
    name: "a comment after a clause colon",
    source: "if ready: first()\nelif other: # header comment\n    second()",
    bodies: ["first()", { endOfLine: 1 }],
  },
  {
    name: "IPython quoted suites requiring ownership validation",
    package: "language-ipython",
    scope: "source.python.ipy",
    source: '# %%\nif ready: print("one")\nelif other: print("two")\nelse: print("three")',
    bodies: ['print("one")', 'print("two")', 'print("three")'],
  },
  {
    name: "IPython commented suites requiring ownership validation",
    package: "language-ipython",
    scope: "source.python.ipy",
    source:
      "# %%\nif ready: first() # first body\nelif other: second() # second body\nelse: third() # third body",
    bodies: ["first()", "second()", "third()"],
  },
  {
    name: "nested IPython quoted suites requiring ownership validation",
    package: "language-ipython",
    scope: "source.python.ipy",
    source:
      '# %%\ndef outer():\n    if ready: print("one")\n    elif other: print("two")\n    else: print("three")',
    bodies: ['print("one")', 'print("two")', 'print("three")'],
    columns: 8,
  },
  {
    name: "a portable root-range provider requiring ownership validation",
    source: "if ready: first()\nelif other: second()\nelse: third()",
    bodies: ["first()", "second()", "third()"],
    rootRanges: {
      module: path.join(__dirname, "fixtures/input-root-ranges.js"),
      method: "all",
      params: {},
    },
  },
  {
    name: "nested suites with a portable root-range provider",
    source: "def outer():\n    if ready: first()\n    elif other: second()\n    else: third()",
    bodies: ["first()", "second()", "third()"],
    columns: 8,
    rootRanges: {
      module: path.join(__dirname, "fixtures/input-root-ranges.js"),
      method: "all",
      params: {},
    },
  },
];

describe("Multicursor syntax indentation", () => {
  let editor;
  let previousExecution;

  beforeEach(async () => {
    jasmine.useRealClock();
    previousExecution = lumine.grammars.syntaxExecution;
    await lumine.packages.activatePackage("language-python");
  });

  afterEach(() => {
    editor?.destroy();
    lumine.grammars.syntaxExecution = previousExecution;
  });

  function normalizedPositions(positions) {
    return positions
      .map((position) => position.serialize())
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }

  async function openFixture(fixture, backend) {
    lumine.grammars.syntaxExecution = backend;
    if (fixture.package) await lumine.packages.activatePackage(fixture.package);
    editor = await lumine.workspace.open();
    editor.setText(fixture.source);
    if (fixture.rootRanges) {
      lumine.grammars.setRootLanguageRanges(editor.getBuffer(), fixture.rootRanges);
      expect(lumine.grammars.rootLanguageRangesByBuffer.get(editor.getBuffer()).descriptor).toEqual(
        fixture.rootRanges,
      );
    }
    expect(
      lumine.grammars.assignLanguageMode(editor.getBuffer(), fixture.scope ?? "source.python"),
    ).toBe(true);
    await editor.whenGrammarSettled();
    editor.update({ autoIndent: true, tabLength: 4, softTabs: fixture.softTabs ?? true });
    expect(editor.getSoftTabs()).toBe(fixture.softTabs ?? true);
    const mode = editor.getBuffer().getLanguageMode();
    expect(mode.asynchronousSyntax === true).toBe(backend === "worker");
    if (backend === "inline") expect(mode.tree.rootNode.hasError).toBe(false);
    return mode;
  }

  async function check(fixture, backend, selected) {
    const mode = await openFixture(fixture, backend);
    const buffer = editor.getBuffer();
    const offsets = fixture.bodies.map((body) =>
      typeof body === "string"
        ? fixture.source.indexOf(body)
        : fixture.source
            .split("\n")
            .slice(0, body.endOfLine + 1)
            .join("\n").length,
    );
    const positions = selected.map((index) => buffer.positionForCharacterIndex(offsets[index]));
    editor.setSelectedBufferRanges(positions.map((position) => [position, position]));
    const originalSelections = editor.getSelectedBufferRanges().map((range) => range.serialize());
    buffer.clearUndoStack();
    const columns = fixture.columns ?? 4;
    const prefix = fixture.prefix ?? " ".repeat(columns);
    const ascending = [...selected].sort((a, b) => offsets[a] - offsets[b]);
    let expected = fixture.source;
    let raw = fixture.source;
    for (const index of [...ascending].reverse()) {
      expected = expected.slice(0, offsets[index]) + "\n" + prefix + expected.slice(offsets[index]);
      raw = raw.slice(0, offsets[index]) + "\n" + raw.slice(offsets[index]);
    }
    const expectedPositions = ascending.map((index, order) => [
      buffer.positionForCharacterIndex(offsets[index]).row + order + 1,
      columns,
    ]);
    const publications = [];
    const compact = fixture.bulk ? spyOn(mode, "prepareInputIndentation").and.callThrough() : null;
    const stream = fixture.bulk ? spyOn(mode, "scanPreparedIndentation").and.callThrough() : null;
    const subscription = buffer.onDidApplyChanges(() => publications.push(editor.getText()));
    try {
      await editor.insertNewline();
      expect(await editor.whenGrammarSettled()).toBeTrue();
    } finally {
      subscription?.dispose();
    }
    expect(editor.getText()).toBe(expected);
    expect(normalizedPositions(editor.getCursorBufferPositions())).toEqual(expectedPositions);
    expect(publications).toEqual(
      backend === "worker" || selected.length === 1 ? [expected] : [raw, expected],
    );
    if (fixture.bulk) {
      expect(compact).not.toHaveBeenCalled();
      expect(stream).toHaveBeenCalledTimes(1);
    }
    const resultSelections = editor.getSelectedBufferRanges().map((range) => range.serialize());
    await editor.undo();
    await editor.whenGrammarSettled();
    expect(editor.getText()).toBe(fixture.source);
    expect(editor.getSelectedBufferRanges().map((range) => range.serialize())).toEqual(
      originalSelections,
    );
    await editor.redo();
    await editor.whenGrammarSettled();
    expect(editor.getText()).toBe(expected);
    expect(editor.getSelectedBufferRanges().map((range) => range.serialize())).toEqual(
      resultSelections,
    );
    editor.destroy();
    editor = null;
  }

  for (const backend of ["inline", "worker"])
    for (const fixture of fixtures) {
      it(`indents each cursor independently for ${fixture.name} with ${backend} syntax`, async () => {
        for (let index = 0; index < fixture.bodies.length; index++)
          await check(fixture, backend, [index]);
      });
      it(`indents the complete batch for ${fixture.name} with ${backend} syntax`, async () => {
        await check(
          fixture,
          backend,
          fixture.bodies.map((_, index) => index),
        );
      });
      it(`preserves reverse cursor order for ${fixture.name} with ${backend} syntax`, async () => {
        await check(fixture, backend, fixture.bodies.map((_, index) => index).reverse());
      });
    }

  for (const backend of ["inline", "worker"])
    for (const fixture of [fixtures[0], fixtures[9], fixtures[12]])
      it(`orders a rapid Enter, text and Backspace burst for ${fixture.name} with ${backend} syntax`, async () => {
        await openFixture(fixture, backend);
        const buffer = editor.getBuffer();
        const bodies = fixture.bodies.slice(0, 2);
        const offsets = bodies.map((body) => fixture.source.indexOf(body));
        const positions = offsets.map((offset) => buffer.positionForCharacterIndex(offset));
        editor.setSelectedBufferRanges(positions.map((position) => [position, position]));
        const originalSelections = editor
          .getSelectedBufferRanges()
          .map((range) => range.serialize());
        buffer.clearUndoStack();
        const expected = (typed = "") => {
          let text = fixture.source;
          for (const offset of offsets.toSorted((a, b) => b - a))
            text = text.slice(0, offset) + `\n    ${typed}` + text.slice(offset);
          return text;
        };
        // Submit the complete burst in one turn, as the editor input queue
        // receives it. No parser/indentation wait separates these commands.
        const newline = dispatchInput(editor, () => editor.insertNewline());
        const typed = dispatchInput(editor, () => editor.insertText("x"));
        const deleted = dispatchInput(editor, () => editor.backspace());
        await Promise.all([newline, typed, deleted]);
        await editor.whenGrammarSettled();
        expect(editor.getText()).toBe(expected());
        expect(normalizedPositions(editor.getCursorBufferPositions())).toEqual(
          positions.map((position, index) => [position.row + index + 1, 4]),
        );
        await editor.undo();
        expect(editor.getText()).toBe(expected("x"));
        await editor.undo();
        expect(editor.getText()).toBe(expected());
        await editor.undo();
        expect(editor.getText()).toBe(fixture.source);
        expect(editor.getSelectedBufferRanges().map((range) => range.serialize())).toEqual(
          originalSelections,
        );
      });

  for (const backend of ["inline", "worker"]) {
    it(`retains a blank row's suffix prefix before deciding the next cursor with ${backend} syntax`, async () => {
      const source = "if ready: value = 1";
      await openFixture({ source }, backend);
      editor.setSelectedBufferRanges([
        [
          [0, 9],
          [0, 9],
        ],
        [
          [0, 10],
          [0, 10],
        ],
      ]);
      const originalSelections = editor.getSelectedBufferRanges().map((range) => range.serialize());
      editor.getBuffer().clearUndoStack();
      const publications = [];
      const subscription =
        backend === "worker"
          ? editor.getBuffer().onDidApplyChanges(() => publications.push(editor.getText()))
          : null;
      try {
        await editor.insertNewline();
        await editor.whenGrammarSettled();
      } finally {
        subscription?.dispose();
      }
      const expected = "if ready:\n     \n     value = 1";
      expect(editor.getText()).toBe(expected);
      expect(normalizedPositions(editor.getCursorBufferPositions())).toEqual([
        [1, 4],
        [2, 5],
      ]);
      if (backend === "worker") expect(publications).toEqual([expected]);
      await editor.undo();
      await editor.whenGrammarSettled();
      expect(editor.getText()).toBe(source);
      expect(editor.getSelectedBufferRanges().map((range) => range.serialize())).toEqual(
        originalSelections,
      );
      await editor.redo();
      await editor.whenGrammarSettled();
      expect(editor.getText()).toBe(expected);
      expect(normalizedPositions(editor.getCursorBufferPositions())).toEqual([
        [1, 4],
        [2, 5],
      ]);
    });

    it(`plans tab indentation for every branch with ${backend} syntax`, async () => {
      const fixture = {
        source: "if ready: first()\nelif other: second()",
        bodies: ["first()", "second()"],
        prefix: "\t",
        columns: 1,
        softTabs: false,
      };
      await check(fixture, backend, [0, 1]);
    });

    it(`keeps JavaScript blocks and containers correct with ${backend} syntax`, async () => {
      await lumine.packages.activatePackage("language-javascript");
      for (const fixture of [
        {
          source: "if (ready) { first(); }\nelse { second(); }",
          bodies: ["first();", "second();"],
        },
        { source: "const first = [1, 2];\nconst second = [3, 4];", bodies: ["1, 2", "3, 4"] },
      ])
        await check({ ...fixture, scope: "source.js" }, backend, [0, 1]);
    });
  }

  it("projects the same forest when 129 cursors use the streamed worker route", async () => {
    const bodies = Array.from({ length: 129 }, (_, index) => `work_${index}()`);
    const source = bodies
      .map((body, index) => `${index === 0 ? "if" : "elif"} ready_${index}: ${body}`)
      .join("\n");
    await check(
      { source, bodies, bulk: true },
      "worker",
      bodies.map((_, index) => index),
    );
  });

  for (const [name, update] of [
    ["tab length", { tabLength: 2 }],
    ["tab policy", { softTabs: false }],
  ]) {
    it(`discards an inline input plan when ${name} changes while its result is pending`, async () => {
      const source = "if ready: first()\nelif other: second()";
      const mode = await openFixture({ source }, "inline");
      const buffer = editor.getBuffer();
      const positions = ["first()", "second()"].map((body) =>
        buffer.positionForCharacterIndex(source.indexOf(body)),
      );
      editor.setSelectedBufferRanges(positions.map((position) => [position, position]));
      const before = editor.getSelectedBufferRanges().map((range) => range.serialize());
      buffer.clearUndoStack();
      let release, entered, failed;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const ready = new Promise((resolve, reject) => {
        entered = resolve;
        failed = reject;
      });
      const plan = mode.suggestedIndentForInputRows.bind(mode);
      spyOn(mode, "suggestedIndentForInputRows").and.callFake(async (...args) => {
        try {
          const result = await plan(...args);
          entered(result);
          await gate;
          return result;
        } catch (error) {
          failed(error);
          throw error;
        }
      });
      const insertion = editor.insertNewline();
      try {
        const result = await ready;
        expect([...result]).toEqual([
          [1, 1],
          [3, 1],
        ]);
        const raw = "if ready: \nfirst()\nelif other: \nsecond()";
        expect(editor.getText()).toBe(raw);
        editor.update(update);
        release();
        await insertion;
        await editor.whenGrammarSettled();
        expect(editor.getText()).toBe(raw);
        await editor.undo();
        await editor.whenGrammarSettled();
        expect(editor.getText()).toBe(source);
        expect(editor.getSelectedBufferRanges().map((range) => range.serialize())).toEqual(before);
      } finally {
        release();
      }
    });
  }
});
