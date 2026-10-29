const { TextBuffer, TextEditor } = require("lumine");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

describe("TextEditor metadata", () => {
  let editor;

  const rows = () =>
    Object.fromEntries(editor.getMetadata()[0].rows.map((row) => [row.id, row.value]));

  beforeEach(() => {
    editor = new TextEditor();
  });

  afterEach(() => editor.destroy());

  it("describes the live buffer without flattening its contents", () => {
    editor.setText("A😀\r\nsecond\nlast");
    spyOn(editor.buffer, "getText").and.throwError("Metadata must not flatten the buffer");
    expect(rows()).toEqual(
      jasmine.objectContaining({
        encoding: "utf8",
        "line-endings": "Mixed (LF, CRLF)",
        lines: 3,
        length: 16,
        "read-only": false,
      }),
    );
    expect(editor.getMetadata()[0].id).toBe("text");
  });

  it("distinguishes missing line endings from LF and CRLF without changing preferences", () => {
    const preferred = editor.buffer.getPreferredLineEnding();
    expect(rows()["line-endings"]).toBe("None");
    expect(editor.buffer.getPreferredLineEnding()).toBe(preferred);
    editor.setText("a\nb");
    expect(rows()["line-endings"]).toBe("LF");
    editor.setText("a\r\nb");
    expect(rows()["line-endings"]).toBe("CRLF");
  });

  it("invalidates encoding and read-only state and releases its subscriptions", () => {
    const changed = jasmine.createSpy("metadata changed");
    const subscription = editor.onDidChangeMetadata(changed);
    editor.setEncoding("utf16le");
    expect(changed).toHaveBeenCalled();
    expect(rows().encoding).toBe("utf16le");
    changed.calls.reset();
    editor.setReadOnly(true);
    expect(changed).toHaveBeenCalled();
    expect(rows()["read-only"]).toBe(true);
    subscription.dispose();
    changed.calls.reset();
    editor.setEncoding("utf8");
    editor.setReadOnly(false);
    expect(changed).not.toHaveBeenCalled();
  });

  it("invalidates after text settles", () => {
    const changed = jasmine.createSpy("metadata changed");
    const subscription = editor.onDidChangeMetadata(changed);
    editor.setText("updated");
    editor.buffer.emitDidStopChangingEvent();
    expect(changed).toHaveBeenCalled();
    expect(rows().length).toBe(7);
    subscription.dispose();
  });

  it("invalidates saved file details when an explicit reload leaves the text unchanged", async () => {
    jasmine.useRealClock();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lumine-metadata-reload-"));
    const filePath = path.join(directory, "unchanged.txt");
    try {
      await fs.writeFile(filePath, "same text\n");
      const initialDate = new Date("2000-01-01T00:00:00.000Z");
      await fs.utimes(filePath, initialDate, initialDate);
      const buffer = await TextBuffer.load(filePath);
      editor.destroy();
      editor = new TextEditor({ buffer });
      const changed = jasmine.createSpy("metadata changed");
      const textChanged = jasmine.createSpy("text changed");
      const subscription = editor.onDidChangeMetadata(changed);
      const textSubscription = buffer.onDidChange(textChanged);
      const before = editor.getMetadata();

      const nextDate = new Date("2001-01-01T00:00:00.000Z");
      await fs.utimes(filePath, nextDate, nextDate);
      await buffer.reload();

      expect(changed).toHaveBeenCalled();
      expect(textChanged).not.toHaveBeenCalled();
      expect(editor.getMetadata()).toEqual(before);
      expect((await fs.stat(filePath)).mtime.getTime()).toBe(nextDate.getTime());
      subscription.dispose();
      changed.calls.reset();
      await buffer.reload();
      expect(changed).not.toHaveBeenCalled();
      textSubscription.dispose();
    } finally {
      editor.destroy();
      await fs.rm(filePath, { force: true });
      await fs.rmdir(directory);
    }
  });

  it("honors cancellation and retires destroyed editors", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => editor.getMetadata({ signal: controller.signal })).toThrow();
    editor.destroy();
    expect(editor.getMetadata()).toEqual([]);
    expect(() => editor.onDidChangeMetadata(() => {}).dispose()).not.toThrow();
  });
});
