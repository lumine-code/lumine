const fs = require("fs");
const TextBuffer = require("../src/text-buffer");
const TextEditor = require("../src/text-editor");
const TextEditorComponent = require("../src/text-editor-component");

const ROW_COUNT = 16384;
const LINE_LENGTH = 64;
const INSERT_ROW = ROW_COUNT / 2;
const SAMPLE_COUNT = 7;
const WARMUP_COUNT = 2;
const EDITOR_WIDTH = 1000;
const EDITOR_HEIGHT = 800;

function multilineText(label) {
  const line = `${label.padEnd(12, " ")}${"abcdefghijklmnopqrstuvwx".repeat(2)}XYZ\n`;
  expect(line.length).toBe(LINE_LENGTH);
  return line.repeat(ROW_COUNT);
}

function summarize(samplesMs) {
  const sorted = samplesMs.slice().sort((left, right) => left - right);
  return {
    count: samplesMs.length,
    medianMs: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    minMs: sorted[0],
    maxMs: sorted.at(-1),
    samplesMs,
  };
}

describe("Text editor superstring renderer benchmark", () => {
  it("reports large paste, undo and redo model costs and synchronous component updates", () => {
    jasmine.useRealClock();
    const original = multilineText("original");
    const pasted = multilineText("pasted");
    const insertionOffset = INSERT_ROW * LINE_LENGTH;
    const afterPaste =
      original.slice(0, insertionOffset) + pasted + original.slice(insertionOffset);
    const beforePosition = [INSERT_ROW, 0];
    const afterPosition = [INSERT_ROW + ROW_COUNT, 0];
    const clipboard = { readWithMetadata: () => ({ text: pasted }) };
    const buffer = new TextBuffer({ text: original });
    const measurements = Object.fromEntries(
      ["paste", "undo", "redo"].map((operation) => [operation, { model: [], componentUpdate: [] }]),
    );
    let editor;
    let component;

    try {
      editor = new TextEditor({
        buffer,
        autoHeight: false,
        autoWidth: false,
        lineNumberGutterVisible: true,
        showLineNumbers: true,
        softWrapped: false,
      });
      component = new TextEditorComponent({ model: editor, updatedSynchronously: false });
      component.element.style.width = `${EDITOR_WIDTH}px`;
      component.element.style.height = `${EDITOR_HEIGHT}px`;
      jasmine.attachToDOM(component.element);
      component.updateSync();
      editor.setCursorBufferPosition(beforePosition);
      component.updateSync();
      expect(component.visible).toBe(true);
      expect(component.getLineHeight()).toBeGreaterThan(0);

      function checkState(text, position) {
        expect(buffer.getText()).toBe(text);
        expect(editor.getSelectedBufferRange().serialize()).toEqual([position, position]);
        expect(component.element.querySelectorAll(".line").length).toBeGreaterThan(0);
        expect(component.updateScheduled).toBe(false);
      }

      function measure(operation, apply, text, position, record) {
        const modelStart = performance.now();
        const result = apply();
        const modelMs = performance.now() - modelStart;
        // The memory clipboard keeps paste on the synchronous editor path.
        expect(result == null || typeof result.then !== "function").toBe(true);
        const updateStart = performance.now();
        component.updateSync();
        const updateMs = performance.now() - updateStart;
        checkState(text, position);
        if (record) {
          measurements[operation].model.push(modelMs);
          measurements[operation].componentUpdate.push(updateMs);
        }
      }

      checkState(original, beforePosition);
      for (let sample = -WARMUP_COUNT; sample < SAMPLE_COUNT; sample++) {
        const record = sample >= 0;
        measure(
          "paste",
          () => editor.pasteText({ clipboard, autoIndent: false, normalizeLineEndings: false }),
          afterPaste,
          afterPosition,
          record,
        );
        measure("undo", () => editor.undo(), original, beforePosition, record);
        measure("redo", () => editor.redo(), afterPaste, afterPosition, record);

        // Restore the same already-open document without timing setup or retaining history.
        editor.undo();
        component.updateSync();
        checkState(original, beforePosition);
        buffer.clearUndoStack();
      }

      const report = {
        runtime: {
          electron: process.versions.electron,
          node: process.versions.node,
          napi: process.versions.napi,
          platform: process.platform,
          arch: process.arch,
        },
        input: {
          originalCharacters: original.length,
          pastedCharacters: pasted.length,
          originalLineCount: ROW_COUNT + 1,
          pastedNewlineCount: ROW_COUNT,
          insertionPosition: beforePosition,
          sampleCount: SAMPLE_COUNT,
          warmupCount: WARMUP_COUNT,
          editorWidth: EDITOR_WIDTH,
          editorHeight: EDITOR_HEIGHT,
          softWrapped: false,
          syntax: buffer.getLanguageMode().constructor.name,
          clipboard: "synchronous memory clipboard; excludes clipboard IPC",
          autoIndent: false,
        },
        timing: {
          model: "synchronous TextEditor command with component updates scheduled",
          componentUpdate:
            "explicit component.updateSync; DOM and layout work, excludes frame paint",
        },
        results: Object.entries(measurements).map(([operation, samples]) => ({
          operation,
          model: summarize(samples.model),
          componentUpdate: summarize(samples.componentUpdate),
        })),
      };
      const output = process.env.LUMINE_SUPERSTRING_RENDERER_BENCHMARK_OUTPUT;
      if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`EDITOR_SUPERSTRING_RENDERER_BENCHMARK=${JSON.stringify(report)}`);
    } finally {
      if (component) component.element.remove();
      if (editor) editor.destroy();
      if (!buffer.isDestroyed()) buffer.destroy();
    }
  }, 60000);
});
