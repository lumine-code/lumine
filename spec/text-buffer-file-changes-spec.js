const fs = require("node:fs");
const TextBuffer = require("../src/text-buffer");
const temp = require("./text-buffer-helpers/temp");
const TextStore = require("../src/text-store");

describe("TextBuffer known file changes", () => {
  let buffer, filePath;

  beforeEach(() => jasmine.useRealClock());

  afterEach(async () => {
    buffer?.destroy();
    buffer = null;
    await lumine.fileWatchClient.settlePendingTeardown();
  });

  async function openFile(text) {
    filePath = temp.openSync("known-file-changes").path;
    fs.writeFileSync(filePath, text);
    buffer = await TextBuffer.load(filePath);
    await buffer.getFileWatchStartPromise();
    await buffer.beginFileOperation();
    return buffer;
  }

  function fileChange(oldText, changes) {
    let newText = oldText;
    for (let index = changes.length - 1; index >= 0; index--) {
      const { start, end, newText: replacement } = changes[index];
      newText = newText.slice(0, start) + replacement + newText.slice(end);
    }
    return { oldText, newText, changes };
  }

  function replaceTargets(oldText, replacement = "replacement") {
    const changes = [];
    for (const match of oldText.matchAll(/target/g)) {
      changes.push({
        start: match.index,
        end: match.index + match[0].length,
        newText: replacement,
      });
    }
    return fileChange(oldText, changes);
  }

  function apply(change) {
    fs.writeFileSync(filePath, change.newText);
    buffer.applyFileChanges(change);
  }

  it("applies the supplied changes to a clean buffer and adopts the written base", async () => {
    const oldText = "first target\nsecond target\n";
    await openFile(oldText);
    const changed = jasmine.createSpy("changed");
    const applied = jasmine.createSpy("applied");
    buffer.onDidChangeText(changed);
    buffer.onDidApplyChanges(applied);

    const change = replaceTargets(oldText);
    apply(change);

    expect(buffer.getText()).toBe(change.newText);
    expect(buffer.getFileState()).toBe("unmodified");
    expect(buffer.buffer.baseTextDigest()).toBe(new TextStore(change.newText).baseTextDigest());
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.calls.mostRecent().args[0].origin).toBe("reload");
    expect(applied).toHaveBeenCalledTimes(1);
    expect(applied.calls.mostRecent().args[0].origin).toBe("reload");
  });

  it("maps disk edits through unsaved rows and columns before their targets", async () => {
    const oldText = "heading\ntarget and target\n";
    await openFile(oldText);
    buffer.insert([0, 0], "unsaved\n");
    buffer.insert([2, 0], "prefix ");

    apply(replaceTargets(oldText));

    expect(buffer.getText()).toBe("unsaved\nheading\nprefix replacement and replacement\n");
    expect(buffer.getFileState()).toBe("modified");
    expect(fs.readFileSync(filePath, "utf8")).toBe("heading\nreplacement and replacement\n");
  });

  it("leaves matches introduced only in unsaved text untouched", async () => {
    const oldText = "disk target\n";
    await openFile(oldText);
    buffer.append("unsaved target\n");

    apply(replaceTargets(oldText));

    expect(buffer.getText()).toBe("disk replacement\nunsaved target\n");
    expect(buffer.getFileState()).toBe("modified");
  });

  it("accounts for edits made by a will-reload observer before applying disk edits", async () => {
    const oldText = "target";
    await openFile(oldText);
    buffer.onWillReload(() => buffer.insert([0, 0], "observer "));

    apply(replaceTargets(oldText));

    expect(buffer.getText()).toBe("observer replacement");
    expect(buffer.getFileState()).toBe("modified");
  });

  it("stops applying disk edits if a will-reload observer destroys the buffer", async () => {
    const oldText = "target";
    await openFile(oldText);
    buffer.onWillReload(() => buffer.destroy());

    apply(replaceTargets(oldText));

    expect(buffer.isDestroyed()).toBe(true);
    expect(buffer.getText()).toBe("");
  });

  it("stops applying disk edits if a will-reload observer retargets the buffer", async () => {
    const oldText = "target";
    await openFile(oldText);
    const otherPath = temp.openSync("retargeted-file-changes").path;
    fs.writeFileSync(otherPath, oldText);
    buffer.onWillReload(() => buffer.setPath(otherPath));

    apply(replaceTargets(oldText));

    expect(buffer.getPath()).toBe(otherPath);
    expect(buffer.getText()).toBe(oldText);
    expect(fs.readFileSync(otherPath, "utf8")).toBe(oldText);
  });

  it("keeps adjacent local insertions outside the replacement range", async () => {
    const oldText = "left target right";
    await openFile(oldText);
    const start = oldText.indexOf("target");
    buffer.insert(buffer.positionForCharacterIndex(start), "(");
    buffer.insert(buffer.positionForCharacterIndex(start + "(target".length), ")");

    apply(replaceTargets(oldText));

    expect(buffer.getText()).toBe("left (replacement) right");
    expect(buffer.getFileState()).toBe("modified");
  });

  it("preserves overlapping local edits while applying other disk edits", async () => {
    const oldText = "first target\nsecond target\n";
    await openFile(oldText);
    buffer.setTextInRange(
      [
        [0, 6],
        [0, 12],
      ],
      "typed",
    );
    const originalBase = buffer.buffer.baseTextDigest();

    apply(replaceTargets(oldText));

    expect(buffer.getText()).toBe("first typed\nsecond replacement\n");
    expect(buffer.getFileState()).toBe("conflicted");
    expect(buffer.buffer.baseTextDigest()).toBe(originalBase);
    expect(fs.readFileSync(filePath, "utf8")).toBe("first replacement\nsecond replacement\n");
  });

  it("preserves a local deletion of a disk match and updates later matches", async () => {
    const oldText = "target\nkeep target\n";
    await openFile(oldText);
    buffer.delete([
      [0, 0],
      [1, 0],
    ]);

    apply(replaceTargets(oldText));

    expect(buffer.getText()).toBe("keep replacement\n");
    expect(buffer.getFileState()).toBe("conflicted");
  });

  it("adopts the new saved base when local edits already produced the disk replacement", async () => {
    const oldText = "target";
    await openFile(oldText);
    buffer.setText("replacement");
    const changed = jasmine.createSpy("changed");
    buffer.onDidChangeText(changed);

    apply(replaceTargets(oldText));

    expect(buffer.getText()).toBe("replacement");
    expect(buffer.getFileState()).toBe("unmodified");
    expect(changed).not.toHaveBeenCalled();
    expect(buffer.undo()).toBe(true);
    expect(buffer.getText()).toBe(oldText);
    expect(buffer.getFileState()).toBe("modified");
    expect(buffer.redo()).toBe(true);
    expect(buffer.getText()).toBe("replacement");
    expect(buffer.getFileState()).toBe("unmodified");
  });

  it("keeps an identical local replacement and unrelated unsaved edits without a conflict", async () => {
    const oldText = "before target after";
    await openFile(oldText);
    buffer.setTextInRange(
      [
        [0, 7],
        [0, 13],
      ],
      "replacement",
    );
    buffer.append("\nunsaved");
    const changed = jasmine.createSpy("changed");
    buffer.onDidChangeText(changed);

    apply(replaceTargets(oldText));

    expect(buffer.getText()).toBe("before replacement after\nunsaved");
    expect(buffer.getFileState()).toBe("modified");
    expect(changed).not.toHaveBeenCalled();
    expect(buffer.undo()).toBe(true);
    expect(buffer.getText()).toBe("before replacement after");
    expect(buffer.getFileState()).toBe("unmodified");
  });

  it("adopts an identical local insertion at a zero-width disk edit", async () => {
    const oldText = "left right";
    await openFile(oldText);
    buffer.insert([0, 4], " disk");
    buffer.append(" unsaved");

    apply(fileChange(oldText, [{ start: 4, end: 4, newText: " disk" }]));

    expect(buffer.getText()).toBe("left disk right unsaved");
    expect(buffer.getFileState()).toBe("modified");
    expect(buffer.undo()).toBe(true);
    expect(buffer.getText()).toBe("left disk right");
    expect(buffer.getFileState()).toBe("unmodified");
  });

  it("adopts a shifted equivalent insertion while applying a separate disk edit", async () => {
    const oldText = "left right target";
    await openFile(oldText);
    buffer.insert([0, 4], " disk");
    buffer.append(" unsaved");
    const target = oldText.indexOf("target");

    apply(
      fileChange(oldText, [
        { start: 4, end: 4, newText: " disk" },
        { start: target, end: target + "target".length, newText: "replacement" },
      ]),
    );

    expect(buffer.getText()).toBe("left disk right replacement unsaved");
    expect(buffer.getFileState()).toBe("modified");
    expect(buffer.undo()).toBe(true);
    expect(buffer.getText()).toBe("left disk right target unsaved");
  });

  it("keeps insertions distinct when another disk edit crosses their equivalent shift", async () => {
    const oldText = "aaab";
    await openFile(oldText);
    buffer.insert([0, 0], "a");

    apply(
      fileChange(oldText, [
        { start: 0, end: 0, newText: "a" },
        { start: 1, end: 2, newText: "X" },
      ]),
    );

    expect(buffer.getText()).toBe("aaXaab");
    expect(buffer.getFileState()).toBe("modified");
    expect(fs.readFileSync(filePath, "utf8")).toBe("aaXab");
    expect(buffer.undo()).toBe(true);
    expect(buffer.getText()).toBe("aaaab");
  });

  it("treats a zero-width disk edit at a local insertion as a conflict", async () => {
    const oldText = "left right";
    await openFile(oldText);
    buffer.insert([0, 4], "local");

    apply(fileChange(oldText, [{ start: 4, end: 4, newText: "disk" }]));

    expect(buffer.getText()).toBe("leftlocal right");
    expect(buffer.getFileState()).toBe("conflicted");
  });

  it("maps a zero-width disk edit past a separate local insertion", async () => {
    const oldText = "left right";
    await openFile(oldText);
    buffer.insert([0, 0], "local ");

    apply(fileChange(oldText, [{ start: 4, end: 4, newText: " disk" }]));

    expect(buffer.getText()).toBe("local left disk right");
    expect(buffer.getFileState()).toBe("modified");
  });

  it("refuses changes whose source does not match the saved buffer base", async () => {
    await openFile("newer target");
    buffer.append(" unsaved");
    const originalText = buffer.getText();
    const originalBase = buffer.buffer.baseTextDigest();
    const changed = jasmine.createSpy("changed");
    buffer.onDidChangeText(changed);

    apply(replaceTargets("older target"));

    expect(buffer.getText()).toBe(originalText);
    expect(buffer.buffer.baseTextDigest()).toBe(originalBase);
    expect(buffer.getFileState()).toBe("conflicted");
    expect(changed).not.toHaveBeenCalled();
  });

  it("does not reapply an already synchronized disk generation", async () => {
    const oldText = "target";
    await openFile(oldText);
    const change = replaceTargets(oldText);
    apply(change);
    buffer.append(" unsaved");
    const changed = jasmine.createSpy("changed");
    buffer.onDidChangeText(changed);

    buffer.applyFileChanges(change);

    expect(buffer.getText()).toBe("replacement unsaved");
    expect(buffer.getFileState()).toBe("modified");
    expect(changed).not.toHaveBeenCalled();
    buffer.undo();
    expect(buffer.getText()).toBe("replacement");
    expect(buffer.getFileState()).toBe("unmodified");
  });

  it("keeps a no-op file replacement out of buffer events and undo history", async () => {
    const oldText = "target";
    await openFile(oldText);
    buffer.append(" unsaved");
    const changed = jasmine.createSpy("changed");
    buffer.onDidChangeText(changed);

    apply({ oldText, newText: oldText, changes: [] });

    expect(buffer.getText()).toBe("target unsaved");
    expect(buffer.getFileState()).toBe("modified");
    expect(changed).not.toHaveBeenCalled();
    buffer.undo();
    expect(buffer.getText()).toBe(oldText);
    expect(buffer.getFileState()).toBe("unmodified");
  });

  it("preserves UTF-16 offsets and CRLF line endings", async () => {
    const oldText = "😀 target\r\nsecond target\r\n";
    await openFile(oldText);
    buffer.insert([0, 0], "unsaved\r\n", { normalizeLineEndings: false });

    apply(replaceTargets(oldText, "ok\nnext"));

    expect(buffer.getText()).toBe("unsaved\r\n😀 ok\nnext\r\nsecond ok\nnext\r\n");
    expect(buffer.getFileState()).toBe("modified");
    expect(fs.readFileSync(filePath, "utf8")).toBe("😀 ok\nnext\r\nsecond ok\nnext\r\n");
  });

  it("removes only carriage returns from CRLF while keeping a clean buffer synchronized", async () => {
    const oldText = "first\r\nsecond\r\n";
    await openFile(oldText);
    const changes = [...oldText.matchAll(/\r/g)].map((match) => ({
      start: match.index,
      end: match.index + 1,
      newText: "",
    }));

    apply(fileChange(oldText, changes));

    expect(buffer.getText()).toBe("first\nsecond\n");
    expect(buffer.getFileState()).toBe("unmodified");
    expect(buffer.undo()).toBe(true);
    expect(buffer.getText()).toBe(oldText);
    expect(buffer.redo()).toBe(true);
    expect(buffer.getText()).toBe("first\nsecond\n");
    expect(buffer.getFileState()).toBe("unmodified");
  });

  it("coalesces distinct disk edits to the two characters in each CRLF ending", async () => {
    const oldText = "first\r\nsecond\r\n";
    await openFile(oldText);
    const changes = [...oldText.matchAll(/[\r\n]/g)].map((match) => ({
      start: match.index,
      end: match.index + 1,
      newText: "X",
    }));

    apply(fileChange(oldText, changes));

    expect(buffer.getText()).toBe("firstXXsecondXX");
    expect(buffer.getFileState()).toBe("unmodified");
    expect(buffer.undo()).toBe(true);
    expect(buffer.getText()).toBe(oldText);
    expect(buffer.redo()).toBe(true);
    expect(buffer.getText()).toBe("firstXXsecondXX");
  });

  it("applies zero-width disk edits between carriage return and newline", async () => {
    const oldText = "first\r\nsecond";
    await openFile(oldText);
    const newline = oldText.indexOf("\n");

    apply(fileChange(oldText, [{ start: newline, end: newline, newText: "X" }]));

    expect(buffer.getText()).toBe("first\rX\nsecond");
    expect(buffer.getFileState()).toBe("unmodified");
    expect(buffer.undo()).toBe(true);
    expect(buffer.getText()).toBe(oldText);
    expect(buffer.redo()).toBe(true);
    expect(buffer.getText()).toBe("first\rX\nsecond");
  });

  it("moves markers only through the mapped replacements", async () => {
    const oldText = "target middle target";
    await openFile(oldText);
    buffer.insert([0, 0], "unsaved ");
    const layer = buffer.addMarkerLayer({ maintainHistory: true });
    const marker = layer.markRange(
      [
        [0, 15],
        [0, 21],
      ],
      { invalidate: "never" },
    );

    apply(replaceTargets(oldText));

    expect(buffer.getTextInRange(marker.getRange())).toBe("middle");
    expect(marker.getRange().start.toArray()).toEqual([0, 20]);
    expect(marker.getRange().end.toArray()).toEqual([0, 26]);
    buffer.undo();
    expect(marker.getRange().start.toArray()).toEqual([0, 15]);
    expect(marker.getRange().end.toArray()).toEqual([0, 21]);
    buffer.redo();
    expect(marker.getRange().start.toArray()).toEqual([0, 20]);
    expect(marker.getRange().end.toArray()).toEqual([0, 26]);
  });

  it("groups mapped edits into one undo step without reverting the file on disk", async () => {
    const oldText = "target and target\n";
    await openFile(oldText);
    buffer.insert([0, 0], "unsaved ");
    const beforeReplacement = buffer.getText();
    const change = replaceTargets(oldText);

    apply(change);

    expect(buffer.getText()).toBe("unsaved replacement and replacement\n");
    expect(buffer.undo()).toBe(true);
    expect(buffer.getText()).toBe(beforeReplacement);
    expect(buffer.getFileState()).toBe("modified");
    expect(fs.readFileSync(filePath, "utf8")).toBe(change.newText);
    expect(buffer.undo()).toBe(true);
    expect(buffer.getText()).toBe(oldText);
    expect(buffer.redo()).toBe(true);
    expect(buffer.getText()).toBe(beforeReplacement);
    expect(buffer.redo()).toBe(true);
    expect(buffer.getText()).toBe("unsaved replacement and replacement\n");
    expect(buffer.getFileState()).toBe("modified");
    expect(fs.readFileSync(filePath, "utf8")).toBe(change.newText);
  });
});
