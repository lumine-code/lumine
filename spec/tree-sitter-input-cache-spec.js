const TextBuffer = require("../src/text-buffer");
const TextEditor = require("../src/text-editor");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");
const fs = require("fs");
const temp = require("temp");

describe("Tree-sitter live text input", () => {
  let editor, fixturePath;

  beforeEach(async () => {
    await lumine.packages.activatePackage("language-javascript");
  });

  afterEach(() => {
    editor?.destroy();
    if (fixturePath) fs.unlinkSync(fixturePath);
    fixturePath = null;
  });

  async function buildMode(text) {
    const buffer = new TextBuffer({ text });
    editor = new TextEditor({ buffer });
    expect(lumine.grammars.assignLanguageMode(buffer, "source.js")).toBe(true);
    expect(await editor.whenGrammarSettled()).toBe(true);
    return { buffer, mode: buffer.getLanguageMode() };
  }

  it("reuses bounded buffer reads across neighboring node text lookups", async () => {
    const { buffer, mode } = await buildMode(
      Array.from({ length: 200 }, (_, row) => `const value_${row} = ${row};`).join("\r\n"),
    );
    const identifiers = mode.tree.rootNode.descendantsOfType("identifier");
    mode.textInputChunk = null;
    const reads = spyOn(buffer, "getTextInRange").and.callThrough();

    expect(identifiers.map((node) => node.text)).toEqual(
      Array.from({ length: 200 }, (_, row) => `value_${row}`),
    );
    expect(reads.calls.count()).toBeLessThan(3);
  });

  it("composes UTF-16 and CRLF text across bounded input windows in both directions", async () => {
    const source = Array.from(
      { length: 1800 },
      (_, row) => `const value_${row} = "🐲 ${row}";`,
    ).join("\r\n");
    const { mode } = await buildMode(source);
    for (const chunkSize of [4096, 32768]) {
      for (const start of [0, 32767, 32768, source.indexOf("\r\n") + 1, 17]) {
        let actual = "";
        let index = start;
        while (index < source.length) {
          const chunk = mode.getTextInputChunk(index, chunkSize);
          expect(chunk.length).toBeGreaterThan(0);
          expect(chunk.length).toBeLessThanOrEqual(chunkSize);
          actual += chunk;
          index += chunk.length;
        }
        expect(actual).toBe(source.slice(start));
      }
    }
    expect(mode.tree.rootNode.text).toBe(source);
  });

  it("reflects edits, undo and redo immediately in the edited tree's live input callback", async () => {
    const { buffer, mode } = await buildMode("const alpha = 1;\r\nconst beta = 2;");
    const node = mode.tree.rootNode.descendantsOfType("identifier")[0];
    expect(node.text).toBe("alpha");
    const readIdentifier = () => node.tree.textCallback(6).slice(0, 5);

    buffer.setTextInRange(
      [
        [0, 6],
        [0, 11],
      ],
      "bravo",
    );
    expect(readIdentifier()).toBe("bravo");
    buffer.undo();
    expect(readIdentifier()).toBe("alpha");
    buffer.redo();
    expect(readIdentifier()).toBe("bravo");
    expect(await editor.whenGrammarSettled()).toBe(true);
    expect(mode.tree.rootNode.descendantsOfType("identifier")[0].text).toBe("bravo");
  });

  it("releases the input window when its language mode is destroyed", async () => {
    const { mode } = await buildMode("const alpha = 1;");
    expect(mode.tree.rootNode.text).toBe("const alpha = 1;");
    expect(mode.textInputChunk).not.toBeNull();
    editor.destroy();
    expect(mode.textInputChunk).toBeNull();
  });

  it("exposes changed input to marker and buffer observers before reparsing", async () => {
    const source = "const alpha = 1;";
    const changed = `// changed\n${source}`;
    const { buffer, mode } = await buildMode(source);
    const externalReader = Object.assign(Object.create(TreeSitterLanguageMode.prototype), {
      buffer,
      textInputChunk: null,
    });
    expect(externalReader.getTextInputChunk(0, source.length)).toBe(source);
    const reads = [];
    const marker = buffer.markRange([
      [0, 6],
      [0, 11],
    ]);
    marker.onDidChange(() => reads.push(externalReader.getTextInputChunk(0, changed.length)));
    buffer.onDidChange(() => reads.push(externalReader.getTextInputChunk(0, changed.length)));

    buffer.insert([0, 0], "// changed\n");

    expect(reads).toEqual([changed, changed]);
    expect(await editor.whenGrammarSettled()).toBe(true);
    expect(mode.tree.rootNode.text).toBe(changed);
  });

  it("invalidates independent live input windows for sync and async native reloads", async () => {
    const source = "const alpha = 1;";
    const { buffer } = await buildMode(source);
    const fixture = temp.openSync("tree-sitter-input-cache");
    fixturePath = fixture.path;
    fs.closeSync(fixture.fd);
    fs.writeFileSync(fixturePath, source);
    buffer.setPath(fixturePath);
    buffer.loadSync({ discardChanges: true });
    await buffer.getFileWatchStartPromise();
    const externalReader = Object.assign(Object.create(TreeSitterLanguageMode.prototype), {
      buffer,
      textInputChunk: null,
    });
    expect(externalReader.getTextInputChunk(0, source.length)).toBe(source);

    const syncSource = "const bravo = 2;";
    fs.writeFileSync(fixturePath, syncSource);
    buffer.loadSync({ discardChanges: true });
    expect(externalReader.getTextInputChunk(0, source.length)).toBe(syncSource);

    const asyncSource = "const gamma = 3;";
    fs.writeFileSync(fixturePath, asyncSource);
    const reload = buffer.reload();
    expect(externalReader.getTextInputChunk(0, source.length)).toBe(syncSource);
    await reload;
    expect(buffer.getText()).toBe(asyncSource);
    expect(externalReader.getTextInputChunk(0, source.length)).toBe(asyncSource);
    expect(await editor.whenGrammarSettled()).toBe(true);
  });
});
