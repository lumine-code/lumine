const TextBuffer = require("../src/text-buffer");
const { Range } = TextBuffer;

describe("TextBuffer read-only native diff", () => {
  let buffer;
  afterEach(() => buffer?.destroy());
  it("does not mutate text, history, markers or observers", () => {
    buffer = new TextBuffer({ text: "first=1\nsecond=2\n" });
    const marker = buffer.markRange([
        [1, 0],
        [1, 6],
      ]),
      range = marker.getRange().copy();
    const history = JSON.stringify(buffer.getHistory());
    const changed = jasmine.createSpy("changed"),
      moved = jasmine.createSpy("moved");
    buffer.onDidChange(changed);
    marker.onDidChange(moved);
    const changes = buffer.getChangesToText("first = 1\nsecond = 2\n");
    expect(changes.length).toBeGreaterThan(0);
    expect(buffer.getText()).toBe("first=1\nsecond=2\n");
    expect(JSON.stringify(buffer.getHistory())).toBe(history);
    expect(marker.getRange()).toEqual(range);
    expect(changed).not.toHaveBeenCalled();
    expect(moved).not.toHaveBeenCalled();
  });
  it("returns the same original-coordinate edits as applying the diff API", () => {
    const source = "first=1\nsecond=2\n",
      target = "first = 1\nsecond = 2\n";
    buffer = new TextBuffer({ text: source });
    const expected = buffer
      .getChangesToText(target)
      .map(({ oldRange, newText }) => ({ oldRange, newText }));
    const checkpoint = buffer.createCheckpoint();
    buffer.setTextViaDiff(target);
    expect(
      buffer
        .getChangesSinceCheckpoint(checkpoint)
        .map(({ oldRange, newText }) => ({ oldRange, newText })),
    ).toEqual(expected);
    expect(buffer.getText()).toBe(target);
  });
  it("preserves CRLF and uses UTF-16 columns after non-BMP characters", () => {
    const source = "emoji='😀';value=1\r\nnext=2\r\n",
      target = "emoji='😀';value = 1\r\nnext = 2\r\n";
    buffer = new TextBuffer({ text: source });
    const changes = buffer.getChangesToText(target);
    expect(
      changes.every(
        (change) => change.oldRange instanceof Range && change.newRange instanceof Range,
      ),
    ).toBe(true);
    const copy = new TextBuffer({ text: source });
    try {
      for (const change of [...changes].sort((a, b) => b.oldRange.start.compare(a.oldRange.start)))
        copy.setTextInRange(change.oldRange, change.newText, { normalizeLineEndings: false });
      expect(copy.getText()).toBe(target);
      expect(
        changes.some(
          (change) =>
            change.oldRange.start.row === 0 && change.oldRange.start.column > source.indexOf("😀"),
        ),
      ).toBe(true);
    } finally {
      copy.destroy();
    }
  });
  it("returns no changes for identical text without creating an undo entry", () => {
    buffer = new TextBuffer({ text: "value = 1\n" });
    expect(buffer.getChangesToText(buffer.getText())).toEqual([]);
    expect(buffer.undo()).toBe(false);
  });
});
