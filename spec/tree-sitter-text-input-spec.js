const TextBuffer = require("../src/text-buffer");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");
const TreeSitterDocument = require("../src/tree-sitter-document");
const CSON = require("@lumine-code/season");
const grammarPath = require.resolve("language-javascript/grammars/javascript.json");

describe("Tree-sitter snapshot text input", () => {
  let buffer, grammar, readers;
  beforeEach(() => {
    jasmine.useRealClock();
    buffer = new TextBuffer();
    grammar = null;
    readers = [];
  });
  afterEach(() => {
    for (const reader of readers) reader.close();
    buffer.destroy();
    grammar?.deactivate();
  });
  function document() {
    const reader = new TreeSitterDocument(buffer);
    readers.push(reader);
    return reader;
  }
  async function buildLanguageMode(source) {
    const config = CSON.readFileSync(grammarPath);
    grammar = new TreeSitterGrammar(lumine.grammars, grammarPath, {
      ...config,
      treeSitter: { ...config.treeSitter, injectionsQuery: [] },
    });
    buffer.setText(source);
    const mode = new TreeSitterLanguageMode({
      grammars: lumine.grammars,
      grammar,
      buffer,
      syncTimeoutMicros: 1000000,
    });
    buffer.setLanguageMode(mode);
    await mode.ready;
    return mode;
  }
  function modeWithParser(parser) {
    return Object.assign(Object.create(TreeSitterLanguageMode.prototype), {
      buffer,
      document: document(),
      backgroundSnapshots: new WeakSet(),
      parseDetails: new WeakMap(),
      syncTimeoutMicros: 0,
      acquireParserForLanguage: jasmine
        .createSpy("acquireParserForLanguage")
        .and.returnValue(parser),
      releaseParserForLanguage: jasmine.createSpy("releaseParserForLanguage"),
    });
  }

  it("retains exact UTF-16, CRLF and unpaired surrogates in immutable text snapshots", () => {
    const source = "a\r\n😀\r\nbc\n終\r\n\ud83d";
    buffer.setText(source);
    const reader = document();
    const before = reader.capture();
    buffer.append("\ude00", { normalizeLineEndings: false });
    expect(before.text.toString()).toBe(source);
    expect(reader.capture().text.toString()).toBe(source + "\ude00");
    expect(reader.capture().text.slice(-2)).toBe("😀");
  });

  it("replays exact indices when CRLF is split between patch layers", () => {
    buffer.setText("first\nsecond\n");
    const reader = document();
    const previous = reader.capture();
    buffer.insert([0, 5], "\r", { normalizeLineEndings: false });
    buffer.insert([1, 6], "\r", { normalizeLineEndings: false });
    const snapshot = reader.capture(previous);
    expect(snapshot.text.toString()).toBe("first\r\nsecond\r\n");
    expect(snapshot.edits.map((edit) => [edit.startIndex, edit.oldEndIndex, edit.newText])).toEqual(
      [
        [5, 6, "\r\n"],
        [13, 14, "\r\n"],
      ],
    );
  });

  it("shares one immutable input root per committed revision without flattening", async () => {
    const mode = await buildLanguageMode("const alpha = 1;\r\n");
    const getText = spyOn(buffer, "getText").and.callThrough();
    const getSnapshot = spyOn(buffer, "getTextSnapshot").and.callThrough();
    buffer.append("const beta = 2;\r\n");
    expect(mode.tree.rootNode.hasError).toBe(false);
    expect(mode.tree.rootNode.descendantsOfType("identifier").map((node) => node.text)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(getText).not.toHaveBeenCalled();
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    mode.parse(mode.rootLanguage, null, null);
    expect(getText).not.toHaveBeenCalled();
    expect(getSnapshot).toHaveBeenCalledTimes(1);
  });

  it("captures exact pending UTF-16 edits without delivering or mutating the transaction event", () => {
    const source = "first\n😀second\n";
    buffer.setText(source);
    const reader = document();
    const previous = reader.capture();
    const events = [];
    buffer.onDidApplyChanges((batch) => events.push(batch));
    let first, latest;
    buffer.transact(() => {
      buffer.insert([0, 5], "\r", { normalizeLineEndings: false });
      first = reader.capture(previous);
      expect(first.previous).toBe(previous);
      expect(first.edits.length).toBe(1);
      buffer.insert([1, 2], "\ud800", { normalizeLineEndings: false });
      latest = reader.capture(previous);
      expect(latest.previous).toBe(previous);
      expect(latest.edits.length).toBe(2);
      expect(first.edits.length).toBe(1);
      expect(first.text.toString()).toBe("first\r\n😀second\n");
      expect(events.length).toBe(0);
    });
    expect(events.length).toBe(1);
    expect(buffer.getPendingAppliedChanges()).toBeNull();
    const published = reader.capture(previous);
    expect(published.edits).toEqual(latest.edits);
    let replay = previous.text;
    for (const edit of latest.edits)
      replay = replay.slice(0, edit.startIndex) + edit.newText + replay.slice(edit.oldEndIndex);
    expect(replay).toBe(buffer.getText());
    expect(Object.isFrozen(latest.edits)).toBe(true);
  });

  it("keeps submitted background input stable after the buffer changes", async () => {
    const source = "const first = 1;";
    buffer.setText(source);
    let entered, finish, submitted;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const parser = {
      parse(text) {
        submitted = text;
        entered();
        return new Promise((resolve) => {
          finish = () => resolve({ parsedText: text, input: text });
        });
      },
    };
    const mode = modeWithParser(parser);
    const getText = spyOn(buffer, "getText").and.callThrough();
    const result = mode.parseAsync({}, null, null);
    await started;
    expect(getText).not.toHaveBeenCalled();
    buffer.setText("const later = 2;");
    finish();
    const tree = await result;
    expect(submitted.toString()).toBe(source);
    expect(tree.input.toString()).toBe(source);
    expect(tree.parsedText.toString()).toBe(source);
    expect(mode.releaseParserForLanguage).toHaveBeenCalledTimes(1);
  });

  it("does not acquire a parser when capturing the input fails", async () => {
    buffer.setText("const value = 1;");
    const mode = modeWithParser({ parse: () => null });
    spyOn(buffer, "getTextSnapshot").and.throwError("Cannot freeze text");
    await expectAsync(mode.parseAsync({}, null, null)).toBeRejectedWithError(/Cannot freeze text/);
    expect(mode.acquireParserForLanguage).not.toHaveBeenCalled();
    expect(mode.releaseParserForLanguage).not.toHaveBeenCalled();
  });

  it("preserves large node text containing CRLF and supplementary characters", async () => {
    const prefix = "const value = `";
    const contents = `${"a".repeat(4095 - prefix.length)}\r\n${"b".repeat(4094)}😀${"c".repeat(40000)}`;
    const source = `${prefix}${contents}\`;`;
    const mode = await buildLanguageMode(source);
    const getText = spyOn(buffer, "getText").and.throwError("Unexpected repeated snapshot copy");
    const tree = mode.parse(mode.rootLanguage, null, null);
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.descendantsOfType("template_string")[0].text).toBe(`\`${contents}\``);
    expect(getText).not.toHaveBeenCalled();
  });

  it("keeps retained node text while a new snapshot adopts the edit", async () => {
    const mode = await buildLanguageMode("const value = `old text`;\r\n");
    const tree = mode.parse(mode.rootLanguage, null, null);
    const template = tree.rootNode.descendantsOfType("template_string")[0];
    const getText = spyOn(buffer, "getText").and.callThrough();
    buffer.setTextInRange(
      [
        [0, 15],
        [0, 23],
      ],
      "new text",
    );
    expect(template.text).toBe("`old text`");
    expect(tree.rootNode.hasChanges).toBe(false);
    expect(mode.tree.rootNode.descendantsOfType("template_string")[0].text).toBe("`new text`");
    expect(getText).not.toHaveBeenCalled();
  });
});
