const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Parser, Language } = require("web-tree-sitter");
const DocumentParser = require("../../src/tree-sitter-parser");
const PieceTree = require("../../src/piece-tree");
const { DocumentCore } = require("../../src/document-core");
const TreeSitterDocument = require("../../src/tree-sitter-document");
let language;
before(async () => {
  await Parser.init();
  const grammarPath = require.resolve("language-javascript/grammars/javascript.json");
  const grammar = require("@lumine-code/season").readFileSync(grammarPath);
  language = await Language.load(
    fs.readFileSync(path.join(path.dirname(grammarPath), grammar.treeSitter.grammar)),
  );
});

test("journal coordinates avoid traversing inserted text again", (t) => {
  const parser = new DocumentParser(language);
  try {
    const previous = parser.parseSync(new PieceTree("const a = 1;"), { revision: 0 });
    const inserted = new PieceTree("longer");
    const positionAt = PieceTree.prototype.positionAt;
    t.mock.method(PieceTree.prototype, "positionAt", function (index) {
      if (this === inserted) throw new Error("Redundant inserted-text traversal");
      return positionAt.call(this, index);
    });
    const tree = parser.parseSync(new PieceTree("const longer = 1;"), {
      previous,
      revision: 1,
      edits: [
        {
          startIndex: 6,
          oldEndIndex: 7,
          newText: inserted,
          startPosition: { row: 0, column: 6 },
          oldEndPosition: { row: 0, column: 7 },
          newEndPosition: { row: 0, column: 12 },
        },
      ],
    });
    assert.equal(tree.incremental, true);
    assert.equal(tree.rootNode.text, "const longer = 1;");
    assert.equal(previous.rootNode.text, "const a = 1;");
  } finally {
    parser.close();
  }
});

test("JS document snapshots parse incrementally without flattening and preserve old nodes", () => {
  const parser = new DocumentParser(language);
  const document = new DocumentCore('const café = "😀";\r\n'.repeat(2000));
  const reader = new TreeSitterDocument(document);
  const flatten = PieceTree.prototype.toString;
  PieceTree.prototype.toString = () => {
    throw new Error("Unexpected full materialization");
  };
  try {
    const first = reader.capture();
    const before = parser.parseSync(first.text, first);
    const oldNode = before.rootNode.namedChild(0);
    document.transact((draft) => draft.replace(6, 10, "longName"));
    const snapshot = reader.capture(before);
    const after = parser.parseSync(snapshot.text, snapshot);
    assert.equal(after.incremental, true);
    assert.equal(after.revision, 1);
    assert.equal(after.rootNode.namedChild(0).text, 'const longName = "😀";');
    assert.equal(oldNode.text, 'const café = "😀";');
    assert.equal(after.rootNode.hasError, false);
    document.undo();
    const undone = reader.capture(after);
    assert.equal(parser.parseSync(undone.text, undone).rootNode.namedChild(0).text, oldNode.text);
    document.redo();
    // Exercise the fallback for edit descriptions that lack point coordinates.
    const replayed = parser.parseSync(document.getTextSnapshot(), {
      previous: before,
      edits: [{ startIndex: 6, oldEndIndex: 10, newText: "longName" }],
      revision: document.getTextRevision(),
    });
    assert.equal(replayed.rootNode.namedChild(0).text, 'const longName = "😀";');
  } finally {
    PieceTree.prototype.toString = flatten;
    reader.close();
    parser.close();
  }
});

test("piece input parses astral characters split between pieces and retains suspended input", async () => {
  const parser = new DocumentParser(language);
  const source = " ".repeat(32767) + "𐐀 = `" + "line\r\n😀".repeat(12000) + "`;";
  const document = new DocumentCore(source);
  try {
    const snapshot = document.snapshot();
    const pending = parser.parse(snapshot.text, { revision: snapshot.revision });
    document.transact((draft) => draft.replace(0, document.getTextSnapshot().length, "changed"));
    const tree = await pending;
    assert.equal(tree.rootNode.hasError, false);
    assert.equal(tree.rootNode.descendantsOfType("identifier")[0].text, "𐐀");
    assert.equal(tree.rootNode.text, source.slice(tree.rootNode.startIndex));
    assert.equal(tree.input, source);
    assert.equal(document.getText(), "changed");
  } finally {
    parser.close();
  }
});

test("published WASM trees preserve old nodes and cursors across edits", () => {
  const parser = new DocumentParser(language);
  try {
    const source = 'const café = "🦉";\r\n';
    const before = parser.parseSync(source, { revision: 1 });
    const node = before.rootNode,
      cursor = node.walk();
    const text = "// heading\r\n" + source;
    const next = parser.parseSync(text, {
      previous: before,
      edits: [{ startIndex: 0, oldEndIndex: 0, newText: "// heading\r\n" }],
      revision: 2,
    });
    assert.equal(next.input, text);
    assert.equal(next.rootNode.text, text);
    assert.equal(node.text, source);
    assert.equal(cursor.nodeText, source);
    assert.equal(before.revision, 1);
    assert.equal(next.revision, 2);
    assert.equal(next.incremental, true);
    assert.throws(() => before.edit({}), /published/);
    assert.throws(() => before.delete(), /lifetimes/);
    cursor.delete();
  } finally {
    parser.close();
  }
});

test("bounded parser and node-text callbacks retain UTF-16 across chunk boundaries", () => {
  const parser = new DocumentParser(language);
  const source = " ".repeat(4095) + "𐐀 = `" + "a\r\n😀".repeat(10000) + "`;";
  const parse = parser.parser.parse.bind(parser.parser);
  parser.parser.parse = (input, previous, options) => {
    assert.equal(typeof input, "function");
    assert.ok(input(0).length <= 4096);
    return parse(input, previous, options);
  };
  try {
    const tree = parser.parseSync(source);
    assert.equal(tree.rootNode.hasError, false);
    assert.equal(
      tree.rootNode.text,
      source.slice(tree.rootNode.startIndex, tree.rootNode.endIndex),
    );
    assert.equal(tree.rootNode.descendantsOfType("identifier")[0].text, "𐐀");
    assert.ok(tree.textCallback(0).length <= 32768);
    const retained = tree.rootNode.descendantsOfType("template_string")[0];
    assert.equal(retained.text, "`" + "a\r\n😀".repeat(10000) + "`");
  } finally {
    parser.close();
  }
});

test("large edit batches use a fresh parse without editing the previous tree", () => {
  const parser = new DocumentParser(language);
  try {
    const source = "const value = 1;\n".repeat(150);
    const before = parser.parseSync(source);
    before.copy = () => {
      throw new Error("Bulk updates must not copy and edit the old tree");
    };
    const edits = Array.from({ length: 150 }, (_, row) => ({
      startIndex: row * 17,
      oldEndIndex: row * 17,
      newText: "// ",
    })).reverse();
    const next = parser.parseSync(
      source
        .split("\n")
        .map((line) => line && "// " + line)
        .join("\n"),
      { previous: before, edits },
    );
    assert.equal(next.incremental, false);
    assert.equal(
      next.rootNode.namedChildren.every((node) => node.type === "comment"),
      true,
    );
    assert.equal(before.rootNode.namedChildren[0].type, "lexical_declaration");
  } finally {
    parser.close();
  }
});

test("a timed-out parse resumes, can be cancelled, and leaves the parser reusable", async () => {
  const parser = new DocumentParser(language);
  try {
    const text = "const value = 1;\n".repeat(20000);
    const options = { revision: 5, edits: [] };
    assert.equal(parser.tryParseSync(text, { ...options, timeoutMicros: 0 }), null);
    let yielded = false;
    setImmediate(() => {
      yielded = true;
    });
    const tree = await parser.parse(text, options);
    assert.equal(yielded, true);
    assert.equal(tree.rootNode.endIndex, text.length);
    assert.equal(tree.revision, 5);
    const controller = new AbortController();
    const pending = parser.parse(text, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(parser.parseSync("let next = 1;").rootNode.hasError, false);
  } finally {
    parser.close();
  }
});

test("closing a suspended parse settles without publishing a tree", async () => {
  const parser = new DocumentParser(language);
  const pending = parser.parse("const value = 1;\n".repeat(1000));
  parser.close();
  assert.equal(await pending, null);
  parser.close();
});

test("concurrent calls cannot reset the private tree of a suspended parse", async () => {
  const parser = new DocumentParser(language);
  const controller = new AbortController();
  try {
    const pending = parser.parse("const value = 1;\n".repeat(1000), { signal: controller.signal });
    assert.throws(() => parser.parseSync("let other = 2;"), /active parse/);
    assert.throws(() => parser.tryParseSync("let other = 2;"), /active parse/);
    assert.throws(() => parser.reset(), /active parse/);
    await assert.rejects(parser.parse("let other = 2;"), /active parse/);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(parser.parseSync("let recovered = 3;").rootNode.hasError, false);
  } finally {
    parser.close();
  }
});

test("logger callbacks cannot reenter parsing or free an executing parser", () => {
  const parser = new DocumentParser(language);
  let called = false;
  const logger = () => {
    if (called) return;
    called = true;
    assert.throws(() => parser.parseSync("other;"), /active parse/);
    assert.throws(() => parser.reset(), /active parse/);
    parser.close();
  };
  parser.setLogger(logger);
  assert.equal(parser.getLogger(), logger);
  assert.equal(parser.parseSync("const value = 1;"), null);
  assert.equal(called, true);
  assert.equal(parser.disposed, true);
  parser.close();
  const next = new DocumentParser(language);
  assert.equal(next.parseSync("const intact = 2;").rootNode.hasError, false);
  next.close();
});

test("mixed document and synthetic edits preserve UTF-16 coordinates", () => {
  const parser = new DocumentParser(language);
  try {
    const before = parser.parseSync('let a = "🦉";\r\nlet b = 1;\r\n');
    const text = "//\r\n" + before.input;
    const edits = [
      {
        startIndex: 0,
        oldEndIndex: 0,
        newText: "//\r\n",
        startPosition: { row: 0, column: 0 },
        oldEndPosition: { row: 0, column: 0 },
        newEndPosition: { row: 1, column: 0 },
      },
      { startIndex: 4, oldEndIndex: 7, newText: "let" },
    ];
    const tree = parser.parseSync(text, { previous: before, edits });
    const full = parser.parseSync(text);
    assert.equal(tree.rootNode.toString(), full.rootNode.toString());
    assert.equal(tree.rootNode.text, text);
  } finally {
    parser.close();
  }
});

test("an interrupted incremental parse retains newly included injection content", async () => {
  const regex = await Language.load(
    fs.readFileSync(require.resolve("language-regex/grammars/regex.wasm")),
  );
  const parser = new DocumentParser(regex);
  const source = Array.from({ length: 300 }, (_, i) => `const p${i} = /value${i}+/;\n`).join("");
  function ranges(text) {
    let index = 0;
    return text
      .trimEnd()
      .split("\n")
      .map((line, row) => {
        const start = line.indexOf("/") + 1,
          end = line.lastIndexOf("/");
        const range = {
          startIndex: index + start,
          endIndex: index + end,
          startPosition: { row, column: start },
          endPosition: { row, column: end },
        };
        index += line.length + 1;
        return range;
      });
  }
  try {
    const previous = parser.parseSync(source, { includedRanges: ranges(source) });
    const addition = "const added = /last+/;\n",
      text = source + addition;
    const parse = parser.parser.parse.bind(parser.parser);
    let interrupted = false;
    parser.parser.parse = (input, oldTree, options) =>
      parse(input, oldTree, {
        ...options,
        progressCallback() {
          if (!interrupted && oldTree) {
            interrupted = true;
            return true;
          }
          return false;
        },
      });
    const tree = await parser.parse(text, {
      previous,
      includedRanges: ranges(text),
      revision: 2,
      edits: [{ startIndex: source.length, oldEndIndex: source.length, newText: addition }],
    });
    assert.equal(interrupted, true);
    assert.equal(tree.rootNode.endIndex, ranges(text).at(-1).endIndex);
    assert.equal(tree.rootNode.descendantForIndex(text.lastIndexOf("+")).type, "+");
    assert.equal(previous.input, source);
  } finally {
    parser.close();
  }
});

test("changed boundary hints retain incremental reuse when their source coverage is identical", async () => {
  const parser = new DocumentParser(language);
  try {
    const line = "const value = 1;\n",
      source = line.repeat(300);
    const previous = parser.parseSync(source);
    const text = source.slice(0, 6) + "w" + source.slice(7);
    const parse = parser.parser.parse.bind(parser.parser);
    let interrupted = false;
    parser.parser.parse = (input, oldTree, options) =>
      parse(input, oldTree, {
        ...options,
        progressCallback() {
          if (!interrupted && oldTree) {
            interrupted = true;
            return true;
          }
          return false;
        },
      });
    const tree = await parser.parse(text, {
      previous,
      edits: [{ startIndex: 6, oldEndIndex: 7, newText: "w" }],
      includedRanges: [
        {
          startIndex: 0,
          startPosition: { row: 0, column: 0 },
          endIndex: line.length,
          endPosition: { row: 1, column: 0 },
        },
        {
          startIndex: line.length,
          startPosition: { row: 1, column: 0 },
          endIndex: text.length,
          endPosition: { row: 300, column: 0 },
        },
      ],
    });
    assert.equal(interrupted, true);
    assert.equal(tree.incremental, true);
    assert.equal(tree.rootNode.lastNamedChild.id, previous.rootNode.lastNamedChild.id);
    assert.equal(tree.rootNode.text, text);
  } finally {
    parser.close();
  }
});

test("a long local journal stays incremental and matches a fresh tree after undo", () => {
  const parser = new DocumentParser(language);
  const fresh = new DocumentParser(language);
  const document = new DocumentCore('/* before */\r\nconst café = "😀";\r\n'.repeat(100), {
    historyLimit: 300,
  });
  const reader = new TreeSitterDocument(document);
  const shape = (node) => [
    node.type,
    node.startIndex,
    node.endIndex,
    node.startPosition,
    node.endPosition,
    node.children.map(shape),
  ];
  try {
    const initial = reader.capture();
    const previous = parser.parseSync(initial.text, initial);
    const retained = previous.rootNode.namedChild(1);
    let at = 3;
    for (let i = 0; i < 200; i++) {
      const text = i % 11 === 0 ? "😀\r\n" : "x";
      document.transact((draft) => draft.replace(at, at, text));
      at += text.length;
    }
    const capture = reader.capture(previous);
    assert.equal(capture.edits.length, 1);
    const coordinates = capture.edits.map(
      (edit) =>
        new Proxy(edit, {
          get(target, key) {
            if (key === "newText") throw new Error("Parser must use journal coordinates");
            return Reflect.get(target, key);
          },
        }),
    );
    const updated = parser.parseSync(capture.text, { ...capture, edits: coordinates });
    assert.equal(updated.incremental, true);
    assert.deepEqual(shape(updated.rootNode), shape(fresh.parseSync(capture.text).rootNode));
    for (let i = 0; i < 200; i++) document.undo();
    const undo = reader.capture(updated);
    assert.equal(undo.edits.length, 1);
    const restored = parser.parseSync(undo.text, undo);
    assert.equal(restored.incremental, true);
    assert.deepEqual(shape(restored.rootNode), shape(previous.rootNode));
    assert.equal(retained.text, 'const café = "😀";');
  } finally {
    reader.close();
    parser.close();
    fresh.close();
  }
});

test("disjoint journals retain the bulk fallback instead of widening one edit across untouched text", () => {
  const parser = new DocumentParser(language);
  const document = new DocumentCore("let a = 1;\n".repeat(300));
  const reader = new TreeSitterDocument(document);
  try {
    const first = reader.capture();
    const before = parser.parseSync(first.text, first);
    for (let i = 0; i < 150; i++)
      document.transact((draft) => draft.replace(i * 11 + 4, i * 11 + 5, "b"));
    const capture = reader.capture(before);
    assert.equal(capture.edits.length, 150);
    const tree = parser.parseSync(capture.text, capture);
    assert.equal(tree.incremental, false);
    assert.equal(tree.rootNode.hasError, false);
  } finally {
    reader.close();
    parser.close();
  }
});

test("a suspended incremental parse with earlier errors restarts fresh before resuming", async () => {
  const parser = new DocumentParser(language);
  const fresh = new DocumentParser(language);
  try {
    const prefix = "export function value() { return 1; }\n".repeat(1000);
    const before = new PieceTree(prefix + "aaexport function last() { return 2; }\n");
    const previous = parser.parseSync(before);
    assert.equal(previous.rootNode.hasError, true);
    const start = prefix.length + 2;
    const inserted = "aaaa aaaa aaaa aaaa aaaa\n".repeat(400);
    const text = before.replace(start, start, inserted);
    const parse = parser.parser.parse.bind(parser.parser);
    let suspended = false;
    parser.parser.parse = (input, oldTree, options) =>
      parse(input, oldTree, {
        ...options,
        progressCallback: () => {
          if (!suspended) {
            suspended = true;
            return true;
          }
          return false;
        },
      });
    const point = before.positionAt(start);
    const result = await parser.parse(text, {
      previous,
      edits: [
        {
          startIndex: start,
          oldEndIndex: start,
          newEndIndex: start + inserted.length,
          startPosition: point,
          oldEndPosition: point,
          newEndPosition: text.positionAt(start + inserted.length),
          newText: inserted,
        },
      ],
    });
    assert.equal(suspended, true);
    assert.equal(result.incremental, false);
    assert.equal(result.rootNode.toString(), fresh.parseSync(text).rootNode.toString());
    assert.equal(previous.input, before.toString());
  } finally {
    parser.close();
    fresh.close();
  }
});
