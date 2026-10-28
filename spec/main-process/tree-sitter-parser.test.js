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

test("published node text reads only its requested span rather than a parser-sized chunk", (t) => {
  const parser = new DocumentParser(language);
  const source = new PieceTree("const short = 1;\n//" + "x".repeat(60000));
  try {
    const tree = parser.parseSync(source);
    const node = tree.rootNode.descendantsOfType("identifier")[0];
    const slice = source.slice,
      reads = [];
    t.mock.method(PieceTree.prototype, "slice", function (start, end) {
      if (this === source) reads.push([start, end]);
      return slice.call(this, start, end);
    });
    assert.equal(node.text, "short");
    assert.deepEqual(reads, [[node.startIndex, node.endIndex]]);
  } finally {
    parser.close();
  }
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

test("resuming a parse preserves its native input callback while reattaching the source", async (t) => {
  const parser = new DocumentParser(language);
  const text = new PieceTree("const value = 1;\n".repeat(1000));
  const nativeParse = parser.parser.parse.bind(parser.parser);
  const inputs = [];
  t.mock.method(parser.parser, "parse", (input, previous, options) => {
    inputs.push(input);
    return nativeParse(input, previous, {
      ...options,
      progressCallback: inputs.length === 1 ? () => true : options.progressCallback,
    });
  });
  try {
    assert.equal(parser.tryParseSync(text, { deadline: Infinity }), null);
    const tree = await parser.parse(text);
    assert.ok(inputs.length > 1);
    assert.ok(inputs.every((input) => input === inputs[0]));
    assert.equal(tree.rootNode.endIndex, text.length);
    assert.equal(tree.rootNode.firstNamedChild.text, "const value = 1;");
    assert.equal(inputs[0](0), "");
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

for (const inserted of ["\n", "\r\n\r\n", "const prefix = '🦉';\n", "/* prefix\n", "{"])
  test(`resuming an unrestricted leading insertion keeps incremental reuse (${JSON.stringify(inserted)})`, async () => {
    const parser = new DocumentParser(language);
    const fresh = new DocumentParser(language);
    try {
      const source = new PieceTree("function method(value) { return value + 1; }\n".repeat(2000));
      const previous = parser.parseSync(source);
      const text = source.replace(0, 0, inserted);
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
      const result = await parser.parse(text, {
        previous,
        edits: [{ startIndex: 0, oldEndIndex: 0, newText: inserted }],
        revision: 1,
      });
      const expected = fresh.parseSync(text);
      assert.equal(interrupted, true);
      assert.equal(result.incremental, true);
      assert.equal(result.rootNode.toString(), expected.rootNode.toString());
      assert.equal(result.rootNode.endIndex, text.length);
      assert.deepEqual(result.rootNode.endPosition, expected.rootNode.endPosition);
      assert.equal(previous.input, source.toString());
    } finally {
      parser.close();
      fresh.close();
    }
  });

test("resumed leading edits preserve Python external-scanner state", async () => {
  const python = await Language.load(
    fs.readFileSync(require.resolve("language-python/grammars/python.wasm")),
  );
  const source = new PieceTree(
    "def method(value):\n    if value:\n        return value + 1\n    return 0\n\n".repeat(1500),
  );
  for (const inserted of ["\n", "\r\n\r\n", "# prefix\n", "if True:\n", "    "]) {
    const parser = new DocumentParser(python),
      fresh = new DocumentParser(python);
    try {
      const previous = parser.parseSync(source);
      const text = source.replace(0, 0, inserted);
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
      const result = await parser.parse(text, {
        previous,
        edits: [{ startIndex: 0, oldEndIndex: 0, newText: inserted }],
      });
      const expected = fresh.parseSync(text);
      assert.equal(interrupted, true);
      assert.equal(result.incremental, true);
      assert.equal(
        result.rootNode.toString(),
        expected.rootNode.toString(),
        JSON.stringify(inserted),
      );
      assert.deepEqual(result.rootNode.endPosition, expected.rootNode.endPosition);
    } finally {
      parser.close();
      fresh.close();
    }
  }
});

test("cancelled checkpoint replay preserves the latest source and repaired valid AST", async (t) => {
  const parser = new DocumentParser(language),
    reference = new DocumentParser(language),
    document = new DocumentCore("export function value() { return 1; }\n".repeat(18000)),
    reader = new TreeSitterDocument(document);
  try {
    const firstInput = reader.capture(),
      healthy = parser.parseSync(firstInput.text, firstInput),
      start = firstInput.text.lineStart(17000);
    document.transact((draft) => draft.replace(start, start, "a"));
    const damagedInput = reader.capture(healthy),
      displayed = parser.parseSync(damagedInput.text, damagedInput);
    assert.equal(displayed.rootNode.hasError, true);
    for (let i = 0; i < 200; i++)
      document.transact((draft) =>
        draft.replace(start + i + 1, start + i + 1, i % 12 === 11 ? " " : "a"),
      );
    const input = reader.capture(healthy),
      comparison = reader.capture(displayed),
      nativeParse = parser.parser.parse.bind(parser.parser),
      controller = new AbortController();
    let callbacks = 0,
      cancel = true;
    t.mock.method(parser.parser, "parse", (source, previous, options) =>
      nativeParse(source, previous, {
        ...options,
        progressCallback: () => {
          callbacks++;
          if (cancel && callbacks === 100) {
            controller.abort();
            return true;
          }
          return callbacks % 3 === 0;
        },
      }),
    );
    await assert.rejects(
      parser.parse(input.text, { ...input, comparison, signal: controller.signal }),
      { name: "AbortError" },
    );
    assert.equal(callbacks, 100);
    assert.equal(parser.pending, null);
    cancel = false;
    const tree = await parser.parse(input.text, { ...input, comparison });
    assert.equal(tree.incremental, true);
    assert.equal(tree.changedRangesBaseRevision, displayed.revision);
    assert.equal(tree.revision, document.getTextRevision());
    assert.equal(tree.input, input.text.toString());
    assert.equal(tree.rootNode.toString(), reference.parseSync(input.text).rootNode.toString());
    document.transact((draft) => draft.replace(start, start + 201, ""));
    const repairedInput = reader.capture(healthy),
      repairedComparison = reader.capture(tree),
      repaired = await parser.parse(repairedInput.text, {
        ...repairedInput,
        comparison: repairedComparison,
      });
    assert.equal(repaired.rootNode.hasError, false);
    assert.equal(repaired.revision, document.getTextRevision());
    assert.equal(repaired.input, firstInput.text.toString());
    assert.equal(repaired.rootNode.toString(), healthy.rootNode.toString());
    assert.equal(
      repaired.rootNode.toString(),
      reference.parseSync(repairedInput.text).rootNode.toString(),
    );
  } finally {
    reader.close();
    parser.close();
    reference.close();
  }
});

test("a separate comparison base computes ranges once against the displayed revision", (t) => {
  const { Tree } = require("web-tree-sitter");
  const parser = new DocumentParser(language),
    document = new DocumentCore('const café = "😀";\r\n');
  const reader = new TreeSitterDocument(document);
  try {
    const first = reader.capture(),
      healthy = parser.parseSync(first.text, first);
    const start = document.getText().indexOf('"');
    document.transact((d) => d.replace(start, start + 4, ""));
    const damagedInput = reader.capture(healthy),
      displayed = parser.parseSync(damagedInput.text, damagedInput);
    assert.equal(displayed.rootNode.hasError, true);
    document.undo();
    const input = reader.capture(healthy),
      comparison = reader.capture(displayed);
    const edited = DocumentParser.prepareTree(displayed, input.text, comparison);
    const expected = edited.getChangedRanges(healthy);
    edited.delete();
    assert.ok(expected.length > 0);
    const copies = [],
      disposed = [],
      compared = [];
    for (const base of [healthy, displayed]) {
      const copy = base.copy.bind(base);
      t.mock.method(base, "copy", () => {
        const tree = copy();
        copies.push({ base, tree });
        return tree;
      });
    }
    const compare = Tree.prototype.getChangedRanges,
      dispose = Tree.prototype.delete;
    t.mock.method(Tree.prototype, "getChangedRanges", function (next) {
      compared.push(this);
      return compare.call(this, next);
    });
    t.mock.method(Tree.prototype, "delete", function () {
      if (copies.some((c) => c.tree === this)) disposed.push(this);
      return dispose.call(this);
    });
    const tree = parser.parseSync(input.text, { ...input, comparison });
    assert.equal(tree.incremental, true);
    assert.equal(tree.changedRangesBaseRevision, displayed.revision);
    assert.deepEqual(tree.changedRanges, expected);
    assert.equal(compared.length, 1);
    assert.equal(compared[0], copies.find((c) => c.base === displayed).tree);
    assert.equal(copies.length, 2);
    assert.deepEqual(new Set(disposed), new Set(copies.map((c) => c.tree)));
    assert.equal(disposed.length, 2);
    assert.equal(tree.rootNode.toString(), healthy.rootNode.toString());
    assert.equal(displayed.input, damagedInput.text.toString());
    assert.ok(Object.isFrozen(tree.changedRanges));
  } finally {
    reader.close();
    parser.close();
  }
});

test("suspended jobs defer comparison copies and changing the comparison resets the job", (t) => {
  const parser = new DocumentParser(language);
  try {
    const healthy = parser.parseSync("let x = 1;", { revision: 1 });
    const displayed = parser.parseSync("let y = 1;", { revision: 2 });
    const copies = [];
    const copy = healthy.copy.bind(healthy);
    t.mock.method(healthy, "copy", () => {
      const tree = copy();
      const dispose = tree.delete.bind(tree);
      let deleted = false;
      tree.delete = () => {
        assert.equal(deleted, false);
        deleted = true;
        dispose();
      };
      copies.push(() => deleted);
      return tree;
    });
    t.mock.method(displayed, "copy", () => {
      throw Error("Must not prepare a cancelled comparison");
    });
    t.mock.method(parser.parser, "parse", () => null);
    const comparison = { previous: displayed, edits: [] };
    const options = { previous: healthy, edits: [], comparison, timeoutMicros: 1000000 };
    assert.equal(parser.tryParseSync("let x = 1;", options), null);
    const first = parser.pending;
    assert.equal(parser.tryParseSync("let x = 1;", options), null);
    assert.equal(parser.pending, first);
    assert.equal(copies.length, 1);
    assert.equal(
      parser.tryParseSync("let x = 1;", { ...options, comparison: { ...comparison } }),
      null,
    );
    assert.notEqual(parser.pending, first);
    assert.equal(copies.length, 2);
    assert.equal(copies[0](), true);
    parser.close();
    assert.equal(copies[1](), true);
    assert.equal(parser.pending, null);
  } finally {
    parser.close();
  }
});

test("failed comparison preparation and range queries release private trees", (t) => {
  const { Tree } = require("web-tree-sitter"),
    parser = new DocumentParser(language);
  try {
    const healthy = parser.parseSync("let x = 1;", { revision: 1 }),
      displayed = parser.parseSync("let y = 1;", { revision: 2 });
    const copies = [],
      disposed = new Map(),
      dispose = Tree.prototype.delete;
    for (const base of [healthy, displayed]) {
      const copy = base.copy.bind(base);
      t.mock.method(base, "copy", () => {
        const tree = copy();
        copies.push(tree);
        return tree;
      });
    }
    t.mock.method(Tree.prototype, "delete", function () {
      disposed.set(this, (disposed.get(this) ?? 0) + 1);
      return dispose.call(this);
    });
    const options = {
      previous: healthy,
      edits: [],
      comparison: {
        previous: displayed,
        edits: [
          {
            startIndex: 0,
            oldEndIndex: 0,
            get newText() {
              throw Error("prepare failure");
            },
          },
        ],
      },
    };
    assert.throws(() => parser.parseSync("let x = 1;", options), /prepare failure/);
    assert.equal(parser.pending, null);
    assert.equal(copies.length, 2);
    for (const tree of copies) assert.equal(disposed.get(tree), 1);
    t.mock.method(Tree.prototype, "getChangedRanges", () => {
      throw Error("compare failure");
    });
    assert.throws(
      () =>
        parser.parseSync("let x = 1;", {
          ...options,
          comparison: { previous: displayed, edits: [] },
        }),
      /compare failure/,
    );
    assert.equal(parser.pending, null);
    assert.equal(copies.length, 4);
    for (const tree of copies) assert.equal(disposed.get(tree), 1);
    // Each failed job also releases the newly parsed, unpublished result.
    assert.equal(disposed.size, 6);
    for (const count of disposed.values()) assert.equal(count, 1);
  } finally {
    parser.close();
  }
});

test("fresh and explicitly untracked parses do not prepare a comparison tree", (t) => {
  const parser = new DocumentParser(language);
  try {
    const previous = parser.parseSync("let x = 1;", { revision: 7 });
    const displayed = parser.parseSync("let y = 1;", { revision: 8 });
    t.mock.method(displayed, "copy", () => {
      throw Error("Unused comparison");
    });
    const edits = Array.from({ length: DocumentParser.bulkEditLimit }, () => ({
      startIndex: 0,
      oldEndIndex: 0,
      newText: "",
    }));
    const fresh = parser.parseSync("let x = 1;", {
      previous,
      edits,
      comparison: { previous: displayed, edits: [] },
    });
    assert.equal(fresh.incremental, false);
    assert.equal(fresh.changedRangesBaseRevision, null);
    assert.deepEqual(fresh.changedRanges, []);
    const untracked = parser.parseSync("let x = 1;", { previous, comparison: null });
    assert.equal(untracked.incremental, true);
    assert.equal(untracked.changedRangesBaseRevision, null);
    const normal = parser.parseSync("let x = 1;", { previous });
    assert.equal(normal.changedRangesBaseRevision, previous.revision);
    assert.throws(
      () => parser.parseSync("let x = 1;", { previous, comparison: { previous: {} } }),
      /published tree/,
    );
    assert.equal(parser.pending, null);
  } finally {
    parser.close();
  }
});

test("a completed native tree waits for the next slice without parsing twice", (t) => {
  const { Tree } = require("web-tree-sitter"),
    parser = new DocumentParser(language);
  try {
    const previous = parser.parseSync("let x = 1;", { revision: 1 });
    const options = { previous, edits: [], revision: 2, deadline: 10 };
    let now = 0,
      parses = 0,
      comparisons = 0;
    t.mock.method(performance, "now", () => now);
    const parse = parser.parser.parse.bind(parser.parser),
      compare = Tree.prototype.getChangedRanges;
    t.mock.method(parser.parser, "parse", (input, old, config) => {
      parses++;
      const tree = parse(input, old, { ...config, progressCallback: () => false });
      now = 20;
      return tree;
    });
    t.mock.method(Tree.prototype, "getChangedRanges", function (other) {
      comparisons++;
      return compare.call(this, other);
    });
    assert.equal(parser.tryParseSync("let x = 1;", options), null);
    assert.ok(parser.pending.parsedTree);
    assert.equal(comparisons, 0);
    now = 0;
    const tree = parser.tryParseSync("let x = 1;", options);
    assert.equal(tree.input, "let x = 1;");
    assert.equal(tree.revision, 2);
    assert.equal(parses, 1);
    assert.equal(comparisons, 1);
    assert.equal(parser.pending, null);
  } finally {
    parser.close();
  }
});

test("cancellation, replacement and close dispose staged native results", async (t) => {
  const { Tree } = require("web-tree-sitter");
  let now = 0;
  t.mock.method(performance, "now", () => now);
  for (const action of ["abort", "replace", "close"]) {
    const parser = new DocumentParser(language);
    const dispose = Tree.prototype.delete,
      disposed = new Map();
    const deleteSpy = t.mock.method(Tree.prototype, "delete", function () {
      disposed.set(this, (disposed.get(this) ?? 0) + 1);
      return dispose.call(this);
    });
    try {
      const previous = parser.parseSync("let x = 1;");
      const parse = parser.parser.parse.bind(parser.parser);
      t.mock.method(parser.parser, "parse", (input, old, config) => {
        const result = parse(input, old, { ...config, progressCallback: () => false });
        now = 20;
        return result;
      });
      const controller = new AbortController(),
        options = { previous, edits: [], revision: 2, deadline: 10, signal: controller.signal };
      now = 0;
      assert.equal(parser.tryParseSync("let x = 1;", options), null);
      const { oldTree, parsedTree } = parser.pending;
      if (action === "abort") {
        controller.abort();
        await assert.rejects(parser.parse("let x = 1;", options), { name: "AbortError" });
      } else if (action === "replace") {
        parser.parseSync("let y = 2;", { revision: 3 });
      } else parser.close();
      assert.equal(disposed.get(oldTree), 1);
      assert.equal(disposed.get(parsedTree), 1);
      assert.equal(parser.pending, null);
    } finally {
      parser.close();
      deleteSpy.mock.restore();
    }
  }
});
