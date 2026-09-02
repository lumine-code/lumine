const NullLanguageMode = require("../src/null-language-mode");
const TextBuffer = require("../src/text-buffer");

describe("NullLanguageMode", () => {
  describe(".getFoldRangeForRow(row, tabLength)", () => {
    it("returns only an indentation fold that starts on the requested row", () => {
      const buffer = new TextBuffer({ text: "outer\n\tchild\n  grandchild\nnext\n" });
      const languageMode = new NullLanguageMode({ buffer });

      const outer = languageMode.getFoldRangeForRow(0, 2);
      expect([outer.start.row, outer.end.row]).toEqual([0, 2]);
      expect(languageMode.getFoldRangeForRow(1, 2)).toBeNull();
      expect(languageMode.getFoldRangeForRow(3, 2)).toBeNull();

      languageMode.destroy();
      buffer.destroy();
    });
  });
});
