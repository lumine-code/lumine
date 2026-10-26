const NullLanguageMode = require("../src/null-language-mode");
const TextBuffer = require("../src/text-buffer");

describe("NullLanguageMode", () => {
  it("checks indentation folds on huge rows without materializing their text", () => {
    const buffer = new TextBuffer({ text: "header" + "x".repeat(1000000) + "\n  child\nnext" });
    const mode = buffer.getLanguageMode();
    spyOn(buffer, "lineForRow").and.throwError("full row read");
    expect(mode.isFoldableAtRowForRendering(0)).toBe(true);
    expect(mode.getFoldRangeForRow(0, 2).end.row).toBe(1);
    expect(mode.suggestedIndentForBufferRow(2, 2)).toBe(1);
    buffer.destroy();
  });

  it("bounds incidental gutter work on huge whitespace-only prefixes", () => {
    const buffer = new TextBuffer({ text: " ".repeat(1000000) + "header\n  child" });
    const mode = buffer.getLanguageMode();
    expect(mode.isFoldableAtRowForRendering(0)).toBe(false);
    expect(mode.indentationForRow(0, 2, 8192).complete).toBe(false);
    buffer.destroy();
  });
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
