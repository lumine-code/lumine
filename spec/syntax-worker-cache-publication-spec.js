const Service = require("../src/syntax-worker-service");
const WorkerMode = require("../src/tree-sitter-worker-language-mode");
const InlineMode = require("../src/tree-sitter-language-mode");
const TextBuffer = require("../src/text-buffer");

describe("Worker paint cache after row edits", () => {
  for (const newline of ["\n", "\r\n"]) {
    it(`matches a fresh parse after newlines, deletion, undo and redo (${JSON.stringify(newline)})`, async () => {
      jasmine.useRealClock();
      await lumine.packages.activatePackage("language-python");
      const grammar = lumine.grammars.grammarForScopeName("source.python");
      const service = new Service(lumine.grammars);
      const text = Array.from({ length: 120 }, (_, index) =>
        [
          `class Record${index}(Structure):  # record description`,
          "    _fields_ = [",
          ...Array.from(
            { length: 10 },
            (_, field) =>
              `        ('field_${field}', c_int), # a comment long enough to cross the preview query budget`,
          ),
          "    ]",
          "",
        ].join(newline),
      ).join(newline);
      const buffer = new TextBuffer(text);
      const mode = new WorkerMode({ buffer, grammar, service });
      buffer.setLanguageMode(mode);
      const display = buffer.addDisplayLayer({ softWrapColumn: 65, tabLength: 4 });
      const owner = {};
      const first = 980,
        last = 1130;
      const view = (layer) => {
        const start = layer.translateBufferPosition([first, 0]).row;
        const end = layer.translateBufferPosition([last, 0]).row;
        return layer.getScreenLines(start, end).map((line) => ({
          text: line.lineText,
          tags: line.tags.map((tag) =>
            tag >= 0 ? tag : `${layer.isOpenTag(tag) ? "+" : "-"}${layer.classNameForTag(tag)}`,
          ),
        }));
      };
      async function check() {
        await mode.atGrammarSettlement();
        mode.requestHighlighting(owner, [[first, last]], true, { prefetch: false });
        await mode.refresh();
        const reference = new TextBuffer(buffer.getText());
        const exact = new InlineMode({
          buffer: reference,
          grammar,
          grammars: lumine.grammars,
          config: lumine.config,
          queryBudget: { now: () => 0 },
        });
        reference.setLanguageMode(exact);
        try {
          await exact.atGrammarSettlement();
          const fresh = reference.addDisplayLayer({ softWrapColumn: 65, tabLength: 4 });
          expect(view(display)).toEqual(view(fresh));
        } finally {
          reference.destroy();
        }
      }
      try {
        await check();
        buffer.clearUndoStack();
        buffer.insert([1008, buffer.lineLengthForRow(1008)], newline);
        view(display);
        buffer.insert([1009, 0], newline);
        view(display);
        await check();
        buffer.delete([
          [1009, 0],
          [1011, 0],
        ]);
        view(display);
        await check();
        buffer.undo();
        view(display);
        await check();
        buffer.redo();
        view(display);
        await check();
      } finally {
        buffer.destroy();
        await service.dispose();
      }
    });
  }
});
