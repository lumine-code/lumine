const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const TextBuffer = require("../src/text-buffer");
const { PieceTree } = require("../src/text-model");

describe("TextBuffer saved-source reuse on reload", () => {
  let directory, buffers;
  beforeEach(() => {
    jasmine.useRealClock();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-reload-reuse-"));
    buffers = [];
  });
  afterEach(async () => {
    for (const buffer of buffers) buffer.destroy();
    await lumine.fileWatchClient.settlePendingTeardown();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("saves, separately loads and discards an edit without reallocating the loaded base or losing history", async () => {
    const file = path.join(directory, "copy.txt");
    let source = new PieceTree("original row\r\n".repeat(2048));
    while (source.length < 16 * 1024 * 1024)
      source = source.replace(source.length, source.length, source);
    const copy = new TextBuffer();
    buffers.push(copy);
    copy.setTextInRange(copy.getRange(), source, { normalizeLineEndings: false });
    copy.setPath(file);
    copy.append("\nWF_SAVED_α😀\r\n", { normalizeLineEndings: false });
    await copy.save();
    const saved = copy.getTextSnapshot();
    const loaded = await TextBuffer.load(file, { mustExist: true });
    buffers.push(loaded);
    await loaded.getFileWatchStartPromise();
    const base = loaded.getTextSnapshot();
    expect(base.equals(saved)).toBe(true);
    loaded.insert([0, 0], "WF_UNSAVED");
    const modified = loaded.getTextSnapshot();
    await loaded.reload();
    expect(loaded.getTextSnapshot()).toBe(base);
    expect(loaded.getFileState()).toBe("unmodified");
    expect(copy.getTextSnapshot()).toBe(saved);
    expect(loaded.undo()).toBe(true);
    expect(loaded.getTextSnapshot().equals(modified)).toBe(true);
    expect(loaded.getFileState()).toBe("modified");
    expect(loaded.redo()).toBe(true);
    expect(loaded.getTextSnapshot().equals(saved)).toBe(true);
    expect(loaded.getFileState()).toBe("unmodified");
  });
});
