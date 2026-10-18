const TextBuffer = require("../src/text-buffer");
const TextEditor = require("../src/text-editor");
const TreeSitterDocument = require("../src/tree-sitter-document");
const fs = require("fs");
const temp = require("temp");

describe("Tree-sitter revisioned text snapshots", () => {
  let editor, fixturePath, readers;

  beforeEach(async () => {
    readers = [];
    await lumine.packages.activatePackage("language-javascript");
  });

  afterEach(() => {
    for (const reader of readers) reader.close();
    editor?.destroy();
    if (fixturePath) fs.unlinkSync(fixturePath);
    fixturePath = null;
  });

  function readerFor(buffer) {
    const reader = new TreeSitterDocument(buffer);
    readers.push(reader);
    return reader;
  }

  async function buildMode(text) {
    const buffer = new TextBuffer({ text });
    editor = new TextEditor({ buffer });
    expect(lumine.grammars.assignLanguageMode(buffer, "source.js")).toBe(true);
    expect(await editor.whenGrammarSettled()).toBe(true);
    return { buffer, mode: buffer.getLanguageMode() };
  }

  it("reads neighboring node text without consulting the live buffer", async () => {
    const { buffer, mode } = await buildMode(
      Array.from({ length: 200 }, (_, row) => `const value_${row} = ${row};`).join("\r\n"),
    );
    const identifiers = mode.tree.rootNode.descendantsOfType("identifier");
    const ranges = spyOn(buffer, "getTextInRange").and.callThrough();
    const text = spyOn(buffer, "getText").and.callThrough();
    expect(identifiers.map((node) => node.text)).toEqual(
      Array.from({ length: 200 }, (_, row) => `value_${row}`),
    );
    expect(ranges).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it("preserves long UTF-16 and CRLF input through replacement and undo", async () => {
    const source = Array.from(
      { length: 1800 },
      (_, row) => `const value_${row} = "🐲 ${row}";`,
    ).join("\r\n");
    const { buffer, mode } = await buildMode(source);
    const previous = mode.tree;
    buffer.insert([1, 0], "// \ud800\r\n", { normalizeLineEndings: false });
    await mode.atGrammarSettlement();
    expect(mode.tree.input).toBe(buffer.getText());
    expect(mode.tree.rootNode.text).toBe(buffer.getText());
    expect(previous.input).toBe(source);
    buffer.undo();
    await mode.atGrammarSettlement();
    expect(mode.tree.input).toBe(source);
    expect(mode.tree.rootNode.text).toBe(source);
  });

  it("publishes edits, undo and redo without changing retained node text", async () => {
    const { buffer, mode } = await buildMode("const alpha = 1;\r\nconst beta = 2;");
    const node = mode.tree.rootNode.descendantsOfType("identifier")[0];
    const current = () => mode.tree.rootNode.descendantsOfType("identifier")[0].text;
    buffer.setTextInRange(
      [
        [0, 6],
        [0, 11],
      ],
      "bravo",
    );
    expect(current()).toBe("bravo");
    expect(node.text).toBe("alpha");
    buffer.undo();
    expect(current()).toBe("alpha");
    buffer.redo();
    expect(current()).toBe("bravo");
    expect(node.text).toBe("alpha");
  });

  it("releases the document cache on destruction while retained snapshots stay valid", async () => {
    const { mode } = await buildMode("const value = 1;");
    const tree = mode.tree;
    expect(mode.document.textSnapshot.text).toBe(tree.input);
    editor.destroy();
    expect(mode.document.closed).toBe(true);
    expect(mode.document.textSnapshot).toBeNull();
    expect(tree.rootNode.text).toBe("const value = 1;");
  });

  it("exposes changed input to marker and buffer observers before reparsing", async () => {
    const source = "const alpha = 1;";
    const changed = `// changed\n${source}`;
    const { buffer, mode } = await buildMode(source);
    const externalReader = readerFor(buffer);
    expect(externalReader.capture().text).toBe(source);
    const reads = [];
    const marker = buffer.markRange([
      [0, 6],
      [0, 11],
    ]);
    marker.onDidChange(() => reads.push(externalReader.capture().text));
    buffer.onDidChange(() => reads.push(externalReader.capture().text));

    buffer.insert([0, 0], "// changed\n");

    expect(reads).toEqual([changed, changed]);
    expect(await editor.whenGrammarSettled()).toBe(true);
    expect(mode.tree.rootNode.text).toBe(changed);
  });

  it("invalidates independent snapshots for sync and async native reloads", async () => {
    const source = "const alpha = 1;";
    const { buffer } = await buildMode(source);
    const fixture = temp.openSync("tree-sitter-input-cache");
    fixturePath = fixture.path;
    fs.closeSync(fixture.fd);
    fs.writeFileSync(fixturePath, source);
    buffer.setPath(fixturePath);
    buffer.loadSync({ discardChanges: true });
    await buffer.getFileWatchStartPromise();
    const externalReader = readerFor(buffer);
    expect(externalReader.capture().text).toBe(source);

    const syncSource = "const bravo = 2;";
    fs.writeFileSync(fixturePath, syncSource);
    buffer.loadSync({ discardChanges: true });
    expect(externalReader.capture().text).toBe(syncSource);

    const asyncSource = "const gamma = 3;";
    fs.writeFileSync(fixturePath, asyncSource);
    const reload = buffer.reload();
    expect(externalReader.capture().text).toBe(syncSource);
    await reload;
    expect(buffer.getText()).toBe(asyncSource);
    expect(externalReader.capture().text).toBe(asyncSource);
    expect(await editor.whenGrammarSettled()).toBe(true);
  });

  it("reads committed native text when a synchronous reload observer throws", async () => {
    const source = "const alpha = 1;";
    const changed = "const bravo = 2;";
    const { buffer } = await buildMode(source);
    const fixture = temp.openSync("tree-sitter-input-cache-throw");
    fixturePath = fixture.path;
    fs.closeSync(fixture.fd);
    fs.writeFileSync(fixturePath, changed);
    buffer.setPath(fixturePath);
    const externalReader = readerFor(buffer);
    expect(externalReader.capture().text).toBe(source);
    expect(buffer.getText()).toBe(source);
    const subscription = buffer.onWillReload(() => {
      throw new Error("Reload observer failed");
    });

    try {
      expect(() => buffer.loadSync({ discardChanges: true })).toThrowError(
        "Reload observer failed",
      );
    } finally {
      subscription.dispose();
    }

    expect(buffer.getTextInRange(buffer.getRange())).toBe(changed);
    expect(externalReader.capture().text).toBe(changed);
    expect(buffer.getText()).toBe(changed);
  });

  for (const ending of ["\r", "\n"]) {
    it(`uses exact edit indices when reloading ${JSON.stringify(ending)} as CRLF`, async () => {
      const source = `const first = 1;${ending}const second = 2;`;
      const changed = "const first = 1;\r\nconst second = 2;";
      const { buffer, mode } = await buildMode(source);
      const fixture = temp.openSync("tree-sitter-input-crlf");
      fixturePath = fixture.path;
      fs.closeSync(fixture.fd);
      fs.writeFileSync(fixturePath, source);
      buffer.setPath(fixturePath);
      buffer.loadSync({ discardChanges: true });
      await buffer.getFileWatchStartPromise();
      fs.writeFileSync(fixturePath, changed);
      await buffer.reload();
      expect(await editor.whenGrammarSettled()).toBe(true);
      const second = () =>
        mode.tree.rootNode.descendantsOfType("identifier").find((node) => node.text === "second");
      expect(mode.tree.rootNode.endIndex).toBe(changed.length);
      expect(second().startIndex).toBe(changed.indexOf("second"));
      expect(second().startPosition.row).toBe(1);
      buffer.undo();
      expect(await editor.whenGrammarSettled()).toBe(true);
      expect(mode.tree.rootNode.endIndex).toBe(source.length);
      expect(second().startIndex).toBe(source.indexOf("second"));
      buffer.redo();
      expect(await editor.whenGrammarSettled()).toBe(true);
      expect(mode.tree.rootNode.endIndex).toBe(changed.length);
      expect(second().startIndex).toBe(changed.indexOf("second"));
    });
  }
});
