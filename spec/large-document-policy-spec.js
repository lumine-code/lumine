const TextEditor = require("../src/text-editor");
const TextBuffer = require("../src/text-buffer");
const TextEditorFactory = require("../src/text-editor-factory");
const { LARGE_DOCUMENT_ROWS } = require("../src/document-cost-policy");

describe("Large document view policy", () => {
  let editors, factory;
  const own = (editor) => {
    editors.push(editor);
    return editor;
  };
  const build = (params = {}) =>
    own(
      new TextEditor({
        buffer: new TextBuffer("x\n".repeat(LARGE_DOCUMENT_ROWS - 1)),
        autoHeight: false,
        softWrapped: true,
        editorWidthInChars: 80,
        ...params,
      }),
    );
  beforeEach(() => {
    editors = [];
    jasmine.useRealClock();
  });
  afterEach(() => {
    factory?.destroy();
    for (const editor of editors) editor.destroy();
  });

  it("selects the unwrapped projection before first use and suppresses no buffer text", () => {
    const editor = build();
    expect(editor.isSoftWrapped()).toBe(false);
    expect(editor.displayLayer.softWrapColumn).toBe(Infinity);
    expect(editor.getScreenLineCount()).toBe(LARGE_DOCUMENT_ROWS);
    expect(editor.getBuffer().getLineCount()).toBe(LARGE_DOCUMENT_ROWS);
    expect(editor.screenPositionForBufferPosition([LARGE_DOCUMENT_ROWS - 1, 0]).row).toBe(
      LARGE_DOCUMENT_ROWS - 1,
    );
  });

  it("copies explicit wrap overrides and keeps later split choices independent", () => {
    const original = build();
    original.setSoftWrapped(true);
    const copy = own(original.copy());
    expect(copy.isSoftWrapped()).toBe(true);
    expect(copy.getSoftWrapColumn()).toBe(copy.displayLayer.softWrapColumn);
    copy.setSoftWrapped(false);
    expect(copy.isSoftWrapped()).toBe(false);
    expect(original.isSoftWrapped()).toBe(true);
    expect(original.displayLayer.softWrapColumn).toBe(80);
  });

  it("copies a disabled optimization policy without silently re-enabling it", () => {
    const original = build({ largeFileOptimizations: false });
    const copy = own(original.copy());
    expect(copy.largeFileOptimizations).toBe(false);
    expect(copy.isSoftWrapped()).toBe(true);
    expect(copy.getSoftWrapColumn()).toBe(copy.displayLayer.softWrapColumn);
  });

  it("binds copied prefix geometry to each view's own font measurements", () => {
    const original = build({
      buffer: new TextBuffer("界".repeat(15000)),
      softWrapped: false,
      maxScreenLineLength: Infinity,
    });
    original.setDefaultCharWidth(10, 20, 10, 20);
    const copy = own(original.copy());
    copy.setDefaultCharWidth(10, 30, 10, 30);
    expect(original.displayLayer.ratioForCharacter("界")).toBe(2);
    expect(copy.displayLayer.ratioForCharacter("界")).toBe(3);
  });

  it("retains a bounded projection when large documents request automatic height", () => {
    const editor = build();
    editor.update({ autoHeight: true });
    expect(editor.getAutoHeight()).toBe(true);
    expect(editor.isSoftWrapped()).toBe(false);
    expect(editor.displayLayer.softWrapColumn).toBe(editor.getSoftWrapColumn());
    editor.update({ autoHeight: false });
    expect(editor.isSoftWrapped()).toBe(false);
    expect(editor.displayLayer.softWrapColumn).toBe(Infinity);
  });

  it("uses hysteresis for threshold edits and restores projection below the exit threshold", () => {
    const editor = build({ buffer: new TextBuffer("x\n".repeat(LARGE_DOCUMENT_ROWS - 2)) });
    const changes = [];
    editor.onDidChangeSoftWrapped((value) => changes.push(value));
    editor.getBuffer().append("x\n");
    expect(editor.isSoftWrapped()).toBe(false);
    expect(editor.displayLayer.softWrapColumn).toBe(Infinity);
    expect(editor.getScreenLineCount()).toBe(LARGE_DOCUMENT_ROWS);
    editor.undo();
    expect(editor.isSoftWrapped()).toBe(false);
    expect(editor.displayLayer.softWrapColumn).toBe(Infinity);
    expect(editor.getScreenLineCount()).toBe(LARGE_DOCUMENT_ROWS - 1);
    editor.redo();
    expect(editor.isSoftWrapped()).toBe(false);
    expect(editor.displayLayer.softWrapColumn).toBe(Infinity);
    expect(changes).toEqual([false]);
    editor.getBuffer().setText("small\n");
    expect(editor.isSoftWrapped()).toBe(true);
    expect(editor.displayLayer.softWrapColumn).toBe(80);
    expect(changes).toEqual([false, true]);
    editor.undo();
    expect(editor.isSoftWrapped()).toBe(false);
    expect(editor.displayLayer.softWrapColumn).toBe(Infinity);
    expect(changes).toEqual([false, true, false]);
  });

  it("restores an explicit wrapping override before configuration maintenance", async () => {
    lumine.config.set("editor.softWrap", false);
    const original = build();
    original.setSoftWrapped(true);
    const saved = original.serialize();
    const restored = own(
      TextEditor.deserialize(saved, {
        project: { bufferForIdSync: () => original.getBuffer() },
        assert: lumine.assert,
        config: lumine.config,
      }),
    );
    expect(restored.isSoftWrapped()).toBe(true);
    factory = new TextEditorFactory({
      config: lumine.config,
      assert: lumine.assert,
      packageManager: { getActivatePromise: () => Promise.resolve() },
    });
    factory.maintainConfig(restored);
    await Promise.resolve();
    await Promise.resolve();
    expect(restored.isSoftWrapped()).toBe(true);
    expect(restored.displayLayer.softWrapColumn).toBe(restored.getSoftWrapColumn());
  });

  it("restores matching retained-buffer folds from a segmented session snapshot", () => {
    const original = build({ buffer: new TextBuffer("one\ntwo\nthree\nfour\n") });
    original.foldBufferRange([
      [1, 0],
      [2, 5],
    ]);
    const savedEditor = original.serialize();
    const savedBuffer = original.getBuffer().serialize({ textSnapshots: true });
    const buffer = original.getBuffer();
    const restored = own(
      TextEditor.deserialize(savedEditor, {
        project: {
          bufferForIdSync: () => buffer,
          restoredBufferAliases: new Map([[buffer.id, { buffer, state: savedBuffer }]]),
        },
        assert: lumine.assert,
        config: lumine.config,
      }),
    );
    expect(restored.displayLayer.foldRangesSnapshot()).toEqual(
      original.displayLayer.foldRangesSnapshot(),
    );
  });

  for (const [name, pattern] of [
    ["CJK", "界"],
    ["astral", "😀"],
    ["combining", "a\u0301"],
    ["joined emoji", "👩‍🔬"],
    ["emoji variation", "✈️"],
  ]) {
    it(`keeps shared ${name} characters at stable logical pixels through forward and backward windows`, () => {
      const editor = build({
        buffer: new TextBuffer(pattern.repeat(15000)),
        softWrapped: false,
        maxScreenLineLength: Infinity,
      });
      const element = editor.getElement();
      element.style.width = "700px";
      element.style.height = "300px";
      jasmine.attachToDOM(element);
      const component = element.getComponent();
      component.updateSync();
      const width = component.getBaseCharacterWidth();
      let previous;
      let comparedCharacters = 0;
      for (const left of [4000, 5000, 4000]) {
        component.setScrollLeft(left * width);
        component.updateSync();
        const line = component.renderedScreenLineForRow(0);
        const lineComponent = component.lineComponentsByScreenLineId.get(line.id);
        const lineLeft = lineComponent.element.getBoundingClientRect().left;
        const viewport = component.refs.scrollContainer.getBoundingClientRect();
        expect(
          lineComponent.textNodes.some((node) => {
            const range = document.createRange();
            range.selectNodeContents(node);
            const rect = range.getBoundingClientRect();
            return rect.width > 0 && rect.right > viewport.left && rect.left < viewport.right;
          }),
        ).toBe(true);
        const positions = new Map();
        const step = 64 * pattern.length;
        for (
          let column = Math.ceil((line.startScreenColumn + step) / step) * step;
          column < line.startScreenColumn + line.lineText.length - step;
          column += step
        ) {
          let offset = column - line.startScreenColumn;
          for (const node of lineComponent.textNodes) {
            if (offset <= node.length) {
              const range = document.createRange();
              range.setStart(node, offset);
              range.setEnd(node, offset);
              positions.set(
                column,
                range.getBoundingClientRect().left - lineLeft + component.renderOriginLeft,
              );
              break;
            }
            offset -= node.length;
          }
        }
        if (previous) {
          const shared = [...positions.keys()].filter((column) => previous.has(column));
          comparedCharacters += shared.length;
          for (const column of shared)
            expect(positions.get(column)).toBeCloseTo(previous.get(column), 0);
        }
        previous = positions;
      }
      expect(comparedCharacters).toBeGreaterThan(0);
    });
  }
});
