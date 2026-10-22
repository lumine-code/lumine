const TextEditor = require("../src/text-editor");
const Range = require("../src/range");
const { setTimeout, clearTimeout } = require("node:timers");

describe("Pending fold cancellation", () => {
  let editor, mode;
  const first = () => new Range([0, 16], [2, 0]);
  const second = () => new Range([3, 16], [5, 0]);
  beforeEach(() => {
    editor = new TextEditor();
    editor.setText("function one() {\n  value();\n}\nfunction two() {\n  value();\n}\n");
    mode = editor.getBuffer().getLanguageMode();
    mode.asynchronousSyntax = true;
  });
  afterEach(() => editor.destroy());

  it("treats a second gutter toggle as cancellation of its pending fold", async () => {
    let release;
    mode.getFoldableRangeContainingPoint = jasmine.createSpy("fold query").and.returnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const a = editor.toggleFoldAtBufferRow(0);
    const b = editor.toggleFoldAtBufferRow(0);
    release(first());
    await Promise.all([a, b]);
    expect(editor.isFoldedAtBufferRow(0)).toBe(false);
    expect(mode.getFoldableRangeContainingPoint).toHaveBeenCalledTimes(1);
  });

  it("keeps a third toggle after the second cancelled the first", async () => {
    const releases = [];
    mode.getFoldableRangeContainingPoint = () => new Promise((resolve) => releases.push(resolve));
    const a = editor.toggleFoldAtBufferRow(0);
    const b = editor.toggleFoldAtBufferRow(0);
    const c = editor.toggleFoldAtBufferRow(0);
    for (const release of releases) release(first());
    await Promise.all([a, b, c]);
    expect(editor.isFoldedAtBufferRow(0)).toBe(true);
    expect(releases.length).toBe(2);
  });

  it("keeps another row's pending toggle when cancelling the first", async () => {
    const releases = [];
    mode.getFoldableRangeContainingPoint = () => new Promise((resolve) => releases.push(resolve));
    const a = editor.toggleFoldAtBufferRow(0);
    const b = editor.toggleFoldAtBufferRow(3);
    editor.toggleFoldAtBufferRow(0);
    releases[0](first());
    releases[1](second());
    await Promise.all([a, b]);
    expect(editor.isFoldedAtBufferRow(0)).toBe(false);
    expect(editor.isFoldedAtBufferRow(3)).toBe(true);
    expect(editor.pendingFoldToggles.size).toBe(0);
    expect(editor.pendingFoldControllers.size).toBe(0);
  });

  it("starts a fresh toggle after an edit invalidates the old target", async () => {
    const releases = [];
    mode.getFoldableRangeContainingPoint = () => new Promise((resolve) => releases.push(resolve));
    const a = editor.toggleFoldAtBufferRow(0);
    editor.getBuffer().append("next");
    const b = editor.toggleFoldAtBufferRow(0);
    releases[0](first());
    releases[1](first());
    await Promise.all([a, b]);
    expect(editor.isFoldedAtBufferRow(0)).toBe(true);
    expect(editor.pendingFoldToggles.size).toBe(0);
    expect(editor.pendingFoldControllers.size).toBe(0);
  });

  it("starts a fresh toggle after fold-all supersedes its previous request", async () => {
    const releases = [];
    let releaseAll;
    mode.getFoldableRangeContainingPoint = () => new Promise((resolve) => releases.push(resolve));
    mode.getFoldableRanges = () =>
      new Promise((resolve) => {
        releaseAll = resolve;
      });
    const a = editor.toggleFoldAtBufferRow(0);
    const all = editor.foldAll();
    const b = editor.toggleFoldAtBufferRow(0);
    releaseAll([second()]);
    for (const release of releases) release(first());
    await Promise.all([a, all, b]);
    expect(releases.length).toBe(2);
    expect(editor.isFoldedAtBufferRow(0)).toBe(true);
    expect(editor.isFoldedAtBufferRow(3)).toBe(false);
  });

  for (const command of ["foldAll", "foldAllAtIndentLevel"]) {
    it(`stops ${command} when a display observer unfolds during application`, async () => {
      mode.getFoldableRanges = () => Promise.resolve([first(), second()]);
      mode.getFoldableRangesAtIndentLevel = mode.getFoldableRanges;
      let unfolded = false;
      const subscription = editor.onDidChange(() => {
        if (!unfolded && editor.isFoldedAtBufferRow(0)) {
          unfolded = true;
          editor.unfoldAll();
        }
      });
      try {
        await editor[command](0);
        expect(unfolded).toBe(true);
        expect(editor.isFoldedAtBufferRow(0)).toBe(false);
        expect(editor.isFoldedAtBufferRow(3)).toBe(false);
      } finally {
        subscription.dispose();
      }
    });
  }

  for (const action of ["unfold", "edit", "destroy", "grammar", "replacement"]) {
    it(`releases the pending command and cancels its provider after ${action}`, async () => {
      let release, signal, timer;
      mode.getFoldableRanges = (_tabLength, options) => {
        signal = options?.signal;
        return new Promise((resolve) => {
          release = resolve;
        });
      };
      const pending = editor.foldAll();
      if (action === "unfold") editor.unfoldAll();
      if (action === "edit") editor.getBuffer().append("changed");
      if (action === "destroy") editor.destroy();
      if (action === "grammar") editor.getBuffer().setLanguageMode(null);
      if (action === "replacement") {
        mode.getFoldableRangeContainingPoint = () => Promise.resolve(second());
        await editor.foldBufferRow(3);
      }
      try {
        const result = await Promise.race([
          pending.then(() => true),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), 50);
          }),
        ]);
        expect(result).toBe(true);
        expect(signal?.aborted).toBe(true);
      } finally {
        clearTimeout(timer);
        release([first()]);
        await pending;
      }
      if (action !== "destroy") expect(editor.isFoldedAtBufferRow(0)).toBe(false);
    });
  }
});
