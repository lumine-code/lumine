const TextEditor = require("../src/text-editor");
const Range = require("../src/range");
const { setTimeout } = require("node:timers");
const Service = require("../src/syntax-worker-service");
const WorkerMode = require("../src/tree-sitter-worker-language-mode");

describe("Asynchronous syntax actions", () => {
  let editor, mode, gate, release;
  beforeEach(() => {
    editor = new TextEditor();
    editor.setText("function work() {\n  value();\n}\n");
    editor.setCursorBufferPosition([1, 3]);
    mode = editor.getBuffer().getLanguageMode();
    mode.asynchronousSyntax = true;
    mode.getRangeForSyntaxNodeContainingRange = () => null;
    gate = new Promise((resolve) => {
      release = resolve;
    });
    mode.syntaxSelectionRanges = () => gate;
    mode.getFoldableRanges = () => gate;
    mode.getFoldableRangeContainingPoint = () => gate;
  });
  afterEach(() => {
    release([]);
    editor.destroy();
  });
  const small = () => new Range([1, 2], [1, 7]);
  const large = () => new Range([1, 2], [1, 9]);
  const fold = () => new Range([0, 17], [2, 0]);

  it("keeps repeated grow commands and queries each next selection", async () => {
    const query = jasmine
      .createSpy("syntaxSelectionRanges")
      .and.callFake((ranges) => (ranges[0].isEmpty() ? gate : Promise.resolve([large()])));
    mode.syntaxSelectionRanges = query;
    const first = editor.selectLargerSyntaxNode();
    const second = editor.selectLargerSyntaxNode();
    release([small()]);
    await Promise.all([first, second]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.calls.argsFor(1)[0]).toEqual([small()]);
    expect(editor.getSelectedBufferRange()).toEqual(large());
    editor.selectSmallerSyntaxNode();
    expect(editor.getSelectedBufferRange()).toEqual(small());
    editor.selectSmallerSyntaxNode();
    expect(editor.getSelectedBufferRange()).toEqual(new Range([1, 3], [1, 3]));
  });

  it("does not grow after the user requests a smaller selection", async () => {
    const pending = editor.selectLargerSyntaxNode();
    editor.selectSmallerSyntaxNode();
    release([small()]);
    await pending;
    expect(editor.getSelectedBufferRange()).toEqual(new Range([1, 3], [1, 3]));
  });

  it("stops queued growth when a selection observer moves the cursor", async () => {
    const query = jasmine.createSpy("query").and.returnValues(gate, Promise.resolve([large()]));
    mode.syntaxSelectionRanges = query;
    let moved = false;
    const subscription = editor.onDidChangeSelectionRange(() => {
      if (!moved) {
        moved = true;
        editor.setCursorBufferPosition([3, 0]);
      }
    });
    try {
      const first = editor.selectLargerSyntaxNode();
      const second = editor.selectLargerSyntaxNode();
      release([small()]);
      await Promise.all([first, second]);
      expect(query).toHaveBeenCalledTimes(1);
      expect(editor.getCursorBufferPosition()).toEqual([3, 0]);
    } finally {
      subscription.dispose();
    }
  });

  it("stops redundant queued requests when no larger node exists", async () => {
    const query = jasmine.createSpy("query").and.returnValue(gate);
    mode.syntaxSelectionRanges = query;
    const pending = Array.from({ length: 8 }, () => editor.selectLargerSyntaxNode());
    release([null]);
    await Promise.all(pending);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("can grow and shrink a read-only editor", async () => {
    editor.setReadOnly(true);
    const pending = editor.selectLargerSyntaxNode();
    release([small()]);
    await pending;
    expect(editor.getSelectedBufferRange()).toEqual(small());
    editor.selectSmallerSyntaxNode();
    expect(editor.getSelectedBufferRange()).toEqual(new Range([1, 3], [1, 3]));
  });

  for (const action of ["grow", "fold"]) {
    for (const change of ["epoch", "edit", "grammar", "destroy"]) {
      it(`discards delayed ${action} after ${change}`, async () => {
        let epoch = 1;
        mode.getSyntaxRequestEpoch = () => epoch;
        const pending = action === "grow" ? editor.selectLargerSyntaxNode() : editor.foldAll();
        if (change === "epoch") epoch++;
        if (change === "edit") editor.getBuffer().append("changed\n");
        if (change === "grammar") editor.getBuffer().setLanguageMode(null);
        if (change === "destroy") editor.destroy();
        release(action === "grow" ? [small()] : [fold()]);
        await pending;
        if (change !== "destroy") {
          expect(editor.getSelectedBufferRange()).toEqual(new Range([1, 3], [1, 3]));
          expect(editor.isFoldedAtBufferRow(0)).toBe(false);
        }
      });
    }
    it(`releases ${action} on destruction without waiting for its provider`, async () => {
      const pending = action === "grow" ? editor.selectLargerSyntaxNode() : editor.foldAll();
      editor.destroy();
      const result = await Promise.race([
        pending.then(() => "cancelled"),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 50)),
      ]);
      expect(result).toBe("cancelled");
      release([]);
      await pending;
    });
  }

  it("does not apply folds computed using an earlier tab length", async () => {
    const pending = editor.foldAll();
    editor.setTabLength(editor.getTabLength() + 1);
    release([fold()]);
    await pending;
    expect(editor.isFoldedAtBufferRow(0)).toBe(false);
  });

  it("does not fold the previous cursor row after the cursor moves", async () => {
    const pending = editor.foldCurrentRow();
    editor.setCursorBufferPosition([3, 0]);
    release(fold());
    await pending;
    expect(editor.isFoldedAtBufferRow(0)).toBe(false);
  });

  it("keeps explicit row folds independent of cursor movement", async () => {
    const pending = editor.foldBufferRow(0);
    editor.setCursorBufferPosition([3, 0]);
    release(fold());
    await pending;
    expect(editor.isFoldedAtBufferRow(0)).toBe(true);
  });
});

describe("Queued selection growth with the syntax worker", () => {
  for (const count of [1, 8, 128]) {
    it(`matches three sequential growth steps for ${count} cursors and shrinks back`, async () => {
      jasmine.useRealClock();
      await lumine.packages.activatePackage("language-javascript");
      const service = new Service(lumine.grammars);
      const editors = [];
      try {
        const source = "function work() {\n" + "  root.branch.leaf(value);\n".repeat(count) + "}\n";
        const initial = Array.from(
          { length: count },
          (_, index) => new Range([index + 1, 3], [index + 1, 3]),
        );
        for (let index = 0; index < 2; index++) {
          const view = lumine.workspace.buildTextEditor();
          editors.push(view);
          view.setText(source);
          view.getBuffer().setLanguageMode(
            new WorkerMode({
              buffer: view.getBuffer(),
              grammar: lumine.grammars.grammarForScopeName("source.js"),
              service,
            }),
          );
          await view.whenGrammarSettled();
          view.setSelectedBufferRanges(initial);
        }
        const [actual, expected] = editors;
        const query = spyOn(
          actual.getBuffer().getLanguageMode(),
          "syntaxSelectionRanges",
        ).and.callThrough();
        await Promise.all(Array.from({ length: 3 }, () => actual.selectLargerSyntaxNode()));
        for (let step = 0; step < 3; step++) await expected.selectLargerSyntaxNode();
        expect(query).toHaveBeenCalledTimes(3);
        expect(query.calls.allArgs().every(([ranges]) => ranges.length === count)).toBe(true);
        expect(actual.getSelectedBufferRanges()).toEqual(expected.getSelectedBufferRanges());
        for (let step = 0; step < 3; step++) actual.selectSmallerSyntaxNode();
        expect(actual.getSelectedBufferRanges()).toEqual(initial);
        expect(actual.pendingSyntaxSelection).toBeNull();
      } finally {
        for (const view of editors) view.destroy();
        await service.dispose();
      }
    });
  }
});
