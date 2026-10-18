const TextBuffer = require("../src/text-buffer");

describe("Bulk change event text", () => {
  it("reconstructs old text without copying the complete span for every edit", () => {
    const source = Array.from({ length: 1000 }, (_, row) => `value_${row} = "λ🦉"\r\n`).join("");
    const buffer = new TextBuffer({ text: source });
    const original = new TextBuffer({ text: source });
    let producedCharacters = 0;
    const slice = String.prototype.slice;
    spyOn(String.prototype, "slice").and.callFake(function (...args) {
      const result = slice.apply(this, args);
      producedCharacters += result.length;
      return result;
    });
    const events = [];
    buffer.onDidChangeText((event) => {
      const before = producedCharacters;
      const oldText = event.oldText;
      expect(producedCharacters - before).toBeLessThan(source.length * 4);
      expect(oldText).toBe(original.getTextInRange(event.oldRange));
      expect(event.newText).toBe(buffer.getTextInRange(event.newRange));
      expect(event.oldText).toBe(oldText);
      events.push(event);
      original.setText(buffer.getText());
    });
    try {
      buffer.setTextInIndependentRanges(
        Array.from({ length: 1000 }, (_, row) => ({
          range: [
            [row, 0],
            [row, row % 3 === 0 ? 5 : 0],
          ],
          text: row % 3 === 0 ? "" : "# ",
        })),
      );
      buffer.undo();
      expect(buffer.getText()).toBe(source);
      buffer.redo();
      expect(events.length).toBe(3);
    } finally {
      buffer.destroy();
      original.destroy();
    }
  });
});
