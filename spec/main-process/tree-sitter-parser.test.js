const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Parser, Language } = require("web-tree-sitter");
const DocumentParser = require("../../src/tree-sitter-parser");
let language;
before(async () => {
  await Parser.init();
  const grammarPath = require.resolve("language-javascript/grammars/javascript.json");
  const grammar = require("@lumine-code/season").readFileSync(grammarPath);
  language = await Language.load(
    fs.readFileSync(path.join(path.dirname(grammarPath), grammar.treeSitter.grammar)),
  );
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
