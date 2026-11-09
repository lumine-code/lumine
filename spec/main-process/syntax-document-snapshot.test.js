const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const Host = require("../../src/syntax-worker-host");
const LanguageMode = require("../../src/tree-sitter-language-mode");
const Parser = require("../../src/tree-sitter-parser");
const SyntaxSnapshot = require("../../src/tree-sitter-syntax-snapshot");
const { configuration } = require("../../src/syntax-worker-environment");

async function setup(text, files) {
  const host = new Host();
  try {
    for (const [key, schema] of Object.entries(require("../../src/config-schema")))
      host.config.setSchema(key, schema);
    const grammars = files.map((name) => {
      const file = require.resolve(name);
      return { file, definition: require("@lumine-code/season").readFileSync(file) };
    });
    await host.dispatch("environment", {
      version: 1,
      configuration: configuration(host.config),
      grammars,
      modules: [],
      specMode: true,
    });
    const data = {
      session: 1,
      revision: 9,
      scopeName: grammars[0].definition.scopeName,
      path: "example",
    };
    await open(host, data, text);
    return { host, data };
  } catch (error) {
    host.close();
    throw error;
  }
}

async function open(host, data, text) {
  await host.dispatch("open", data);
  await host.dispatch("append", { session: data.session, text });
  await host.dispatch("initialize", data);
  await host.dispatch("settle", data);
  return host.sessions.get(data.session).mode;
}

async function fork(host, data, target, changes, initialize = {}) {
  await host.dispatch("fork", { ...data, target });
  await host.dispatch("edit", { session: target, beforeRevision: 0, revision: 1, changes });
  await host.dispatch("initialize", { session: target, ...initialize });
  await host.dispatch("settle", { session: target, revision: 1 });
  return host.sessions.get(target).mode;
}

function changed(source, changes) {
  for (const { startIndex, oldEndIndex, text } of changes)
    source = source.slice(0, startIndex) + text + source.slice(oldEndIndex);
  return source;
}

// Compare all node positions as well as syntax: an AST string alone would not
// detect a missed edit journal or reusing another same-language injection.
function forest(mode) {
  return mode
    .getAllLanguageLayers()
    .map((layer) => {
      const tree = layer.backgroundTree;
      assert.ok(tree, `Missing ${layer.grammar.scopeName} tree`);
      const hash = crypto.createHash("sha256");
      const cursor = tree.walk();
      let done = false;
      try {
        while (!done) {
          const node = cursor.currentNode;
          hash.update(
            JSON.stringify([
              node.type,
              node.isNamed,
              node.isMissing,
              node.startIndex,
              node.endIndex,
              node.startPosition,
              node.endPosition,
            ]),
          );
          if (cursor.gotoFirstChild()) continue;
          while (!cursor.gotoNextSibling()) {
            if (!cursor.gotoParent()) {
              done = true;
              break;
            }
          }
        }
      } finally {
        cursor.delete();
      }
      return {
        scope: layer.grammar.scopeName,
        depth: layer.depth,
        ranges: normalizedRanges(tree, mode.buffer),
        syntax: tree.rootNode.toString(),
        coordinates: hash.digest("hex"),
        error: tree.rootNode.hasError,
      };
    })
    .sort(
      (a, b) =>
        a.depth - b.depth ||
        a.scope.localeCompare(b.scope) ||
        a.ranges[0].startIndex - b.ranges[0].startIndex,
    );
}

function normalizedRanges(tree, buffer) {
  const result = [];
  // Root parse-boundary hints partition unrestricted coverage. Compare their
  // clipped union rather than treating the EOF sentinel as language content.
  for (const range of tree.getIncludedRanges()) {
    const startIndex = Math.min(range.startIndex, buffer.getLength());
    const endIndex = Math.min(range.endIndex, buffer.getLength());
    const previous = result.at(-1);
    if (previous?.endIndex === startIndex) {
      previous.endIndex = endIndex;
      previous.endPosition = buffer.positionForCharacterIndex(endIndex);
    } else {
      result.push({
        startIndex,
        endIndex,
        startPosition: buffer.positionForCharacterIndex(startIndex),
        endPosition: buffer.positionForCharacterIndex(endIndex),
      });
    }
  }
  return result;
}

function recordPrivateParses(t) {
  const parsed = [];
  const original = LanguageMode.prototype.parseAsync;
  t.mock.method(
    LanguageMode.prototype,
    "parseAsync",
    function (language, previous, ranges, options) {
      if (this.indentationOnly)
        parsed.push({ scope: options.scopeName, depth: options.depth, previous, ranges });
      return original.call(this, language, previous, ranges, options);
    },
  );
  return parsed;
}

const ipythonFiles = [
  "language-ipython/grammars/ipython.json",
  "language-python/grammars/python.json",
];
const htmlFiles = [
  "language-html/grammars/html.json",
  "language-javascript/grammars/javascript.json",
  "language-css/grammars/css.json",
];
const html =
  "<!-- fixture -->\n<script>\nconst first = css`\n.first {\n    color: red;\n}\n`;\n</script>\n<script>\nconst second = css`\n.second {\n    color: blue;\n}\n`;\n</script>\n";

test("prepared Enter retains the combined Python injection and applies the exact CRLF journal", async (t) => {
  const text =
    "# %%\r\nclass First:\r\n    value = 1\r\n# %%\r\nclass Second:\r\n    value = 2\r\n";
  const { host, data } = await setup(text, ipythonFiles);
  try {
    const parent = host.sessions.get(1).mode;
    const parentBefore = forest(parent);
    const parsed = recordPrivateParses(t);
    const startIndex = text.indexOf("class Second:") + "class Second:".length;
    const changes = [{ startIndex, oldEndIndex: startIndex, text: "\r\n" }];
    const mode = await fork(host, data, 2, changes);
    const fresh = await open(host, { ...data, session: 3, revision: 1 }, changed(text, changes));
    assert.deepEqual(forest(mode), forest(fresh));
    assert.deepEqual(forest(parent), parentBefore);
    const python = parsed.filter(({ scope }) => scope === "source.python");
    assert.ok(python.length > 0);
    assert.ok(
      python.every(({ previous }) => previous),
      "Combined Python must reuse a previous tree",
    );
    const inherited = python[0].previous;
    assert.notEqual(inherited, parent.getAllInjectionLayers()[0].backgroundTree);
    const result = await host.dispatch("prepared-indent", {
      session: 2,
      revision: 1,
      ranges: [[5, 5]],
      tabLength: 4,
      inline: true,
      options: {
        isPastedText: false,
        rowOptions: new Map([[5, { preserveLeadingWhitespace: true, skipBlankLines: false }]]),
      },
    });
    assert.deepEqual(result.value.levels, [[5, 1]]);
    host.closeSession(2);
    assert.deepEqual(forest(parent), parentBefore);
    assert.equal(host.sessions.get(1).buffer.getText(), text);
  } finally {
    host.close();
  }
});

test("nested snapshots keep independent injections of the same language attached to their owners", async (t) => {
  const { host, data } = await setup(html, htmlFiles);
  try {
    const parentBefore = forest(host.sessions.get(1).mode);
    const parsed = recordPrivateParses(t);
    // Move both owner ranges, then edit only the second nested CSS injection.
    const prefix = "<!-- heading -->\n";
    const offset = html.indexOf("blue;") + "blue;".length + prefix.length;
    const changes = [
      { startIndex: 0, oldEndIndex: 0, text: prefix },
      { startIndex: offset, oldEndIndex: offset, text: "\n" },
    ];
    const mode = await fork(host, data, 2, changes);
    const fresh = await open(host, { ...data, session: 3, revision: 1 }, changed(html, changes));
    const result = forest(mode);
    assert.deepEqual(result, forest(fresh));
    assert.equal(result.filter(({ scope }) => scope === "source.js").length, 2);
    assert.equal(result.filter(({ scope }) => scope === "source.css").length, 2);
    const children = parsed.filter(({ depth }) => depth > 0);
    assert.ok(children.length >= 4);
    assert.ok(
      children.every(({ previous }) => previous),
      `Every compatible nested layer needs its own previous tree: ${JSON.stringify(children.map(({ scope, depth, previous, ranges }) => ({ scope, depth, previous: Boolean(previous), start: ranges?.[0]?.startIndex })))}`,
    );
    assert.equal(new Set(children.map(({ previous }) => previous)).size, children.length);
    host.closeSession(2);
    assert.deepEqual(forest(host.sessions.get(1).mode), parentBefore);
  } finally {
    host.close();
  }
});

test("replacing one injection owner cannot borrow a different same-language owner's snapshot", async (t) => {
  const { host, data } = await setup(html, htmlFiles);
  try {
    const parsed = recordPrivateParses(t);
    const start = html.indexOf("<script>");
    const end = html.indexOf("</script>") + "</script>".length;
    const replacement = "<script>\nfunction replacement() {\n    return 123;\n}\n</script>";
    const changes = [{ startIndex: start, oldEndIndex: end, text: replacement }];
    const mode = await fork(host, data, 2, changes);
    const fresh = await open(host, { ...data, session: 3, revision: 1 }, changed(html, changes));
    assert.deepEqual(forest(mode), forest(fresh));
    const remainingCSS = parsed.filter(({ scope }) => scope === "source.css");
    assert.equal(remainingCSS.length, 1);
    assert.ok(remainingCSS[0].previous, "The surviving second owner still reuses its own CSS tree");
    assert.equal(remainingCSS[0].previous.rootNode.toString().includes("declaration"), true);
  } finally {
    host.close();
  }
});

test("changed injection definitions reject captured child trees before evaluating the new topology", async (t) => {
  const { host, data } = await setup(html, htmlFiles);
  try {
    await host.dispatch("fork", { ...data, target: 2 });
    const grammar = host.grammars.grammarForScopeName("text.html.basic");
    await grammar.setQueryForTest(
      "injectionsQuery",
      `
      ((script_element (raw_text) @injection.content) @injection.owner
        (#set! injection.language "css")
        (#set! injection.include-children))
    `,
    );
    const parsed = recordPrivateParses(t);
    await host.dispatch("initialize", { session: 2 });
    await host.dispatch("settle", { session: 2, revision: 0 });
    const mode = host.sessions.get(2).mode;
    const fresh = await open(host, { ...data, session: 3, revision: 0 }, html);
    assert.deepEqual(forest(mode), forest(fresh));
    const children = parsed.filter(({ depth }) => depth > 0);
    assert.equal(children.length, 2);
    assert.ok(children.every(({ scope, previous }) => scope === "source.css" && !previous));
  } finally {
    host.close();
  }
});

test("a grammar generation change between capture and initialize rejects its saved tree", async (t) => {
  const text = "# %%\nclass First:\n    value = 1\n";
  const { host, data } = await setup(text, ipythonFiles);
  try {
    await host.dispatch("fork", { ...data, target: 2 });
    const grammar = host.grammars.grammarForScopeName("source.python");
    // Reactivation can keep the same parser language handle; the generation
    // must invalidate snapshot compatibility independently of that handle.
    grammar.queryLoadGeneration++;
    const parsed = recordPrivateParses(t);
    await host.dispatch("initialize", { session: 2 });
    await host.dispatch("settle", { session: 2, revision: 0 });
    const fresh = await open(host, { ...data, session: 3, revision: 0 }, text);
    assert.deepEqual(forest(host.sessions.get(2).mode), forest(fresh));
    const python = parsed.filter(({ scope }) => scope === "source.python");
    assert.ok(python.length > 0);
    assert.ok(python.every(({ previous }) => !previous));
  } finally {
    host.close();
  }
});

test("a changed portable root range policy rejects a captured root even when its parser is unchanged", async (t) => {
  const text = "first = 1\nsecond = 2\n";
  const { host, data } = await setup(text, ["language-python/grammars/python.json"]);
  try {
    await host.dispatch("fork", { ...data, target: 2 });
    const policy = {
      module: path.resolve(__dirname, "../fixtures/syntax-worker-analysis.js"),
      method: "rootRanges",
      params: { prefix: "second" },
    };
    host.grammars.setRootLanguageRanges(host.sessions.get(2).buffer, policy);
    const parsed = recordPrivateParses(t);
    await host.dispatch("initialize", { session: 2 });
    await host.dispatch("settle", { session: 2, revision: 0 });
    const fresh = await open(host, { ...data, session: 3, revision: 0, rootRanges: policy }, text);
    assert.deepEqual(forest(host.sessions.get(2).mode), forest(fresh));
    assert.ok(parsed.length > 0);
    assert.ok(parsed.every(({ previous }) => !previous));
    assert.equal(forest(fresh)[0].ranges[0].startIndex, text.indexOf("second"));
  } finally {
    host.close();
  }
});

test("mutating a captured injection's content properties rejects the old baseline", async (t) => {
  const text =
    "const first = css`.first { color: red; }`;\nconst second = css`.second { color: blue; }`;\n";
  const { host, data } = await setup(text, [
    "language-javascript/grammars/javascript.json",
    "language-css/grammars/css.json",
  ]);
  try {
    const grammar = host.grammars.grammarForScopeName("source.js");
    await grammar.setQueryForTest("injectionsQuery", "");
    const point = {
      type: "call_expression",
      language: "css",
      content: (node) =>
        node
          .childForFieldName("arguments")
          .namedChildren.filter((child) => child.type === "string_fragment"),
      includeChildren: false,
    };
    grammar.addInjectionPoint(point);
    await host.dispatch("settle", data);
    await host.dispatch("fork", { ...data, target: 2 });
    point.includeChildren = true;
    const parsed = recordPrivateParses(t);
    await host.dispatch("initialize", { session: 2 });
    await host.dispatch("settle", { session: 2, revision: 0 });
    const fresh = await open(host, { ...data, session: 3, revision: 0 }, text);
    assert.deepEqual(forest(host.sessions.get(2).mode), forest(fresh));
    const nested = parsed.filter(({ scope }) => scope === "source.css");
    assert.equal(nested.length, 2);
    assert.ok(nested.every(({ previous }) => !previous));
  } finally {
    host.close();
  }
});

test("boundary replacements preserve exact syntax when owner matching conservatively declines reuse", async () => {
  for (const side of ["before", "after", "replace"]) {
    const { host, data } = await setup(html, htmlFiles);
    try {
      const start = html.indexOf("<script>");
      const end = html.indexOf("</script>") + "</script>".length;
      const changes =
        side === "before"
          ? [{ startIndex: start - 1, oldEndIndex: start, text: "\r\n<!-- inserted -->\r\n" }]
          : side === "after"
            ? [{ startIndex: end, oldEndIndex: end + 1, text: "\r\n<!-- inserted -->\r\n" }]
            : [
                {
                  startIndex: start,
                  oldEndIndex: end,
                  text: "<script>\nconst value = 5;\n</script>",
                },
              ];
      const mode = await fork(host, data, 2, changes);
      const fresh = await open(host, { ...data, session: 3, revision: 1 }, changed(html, changes));
      assert.deepEqual(forest(mode), forest(fresh), side);
    } finally {
      host.close();
    }
  }
});

test("endpoint insertions reuse compatible owners on either side of a newly inserted boundary", async (t) => {
  for (const location of ["first-owner-start", "owner-end", "content-start"]) {
    const text = location === "first-owner-start" ? html.slice("<!-- fixture -->\n".length) : html;
    const { host, data } = await setup(text, htmlFiles);
    try {
      const parent = host.sessions.get(1).mode;
      const css = parent
        .getAllInjectionLayers()
        .filter((layer) => layer.grammar.scopeName === "source.css")
        .sort(
          (a, b) => a.backgroundTree.rootNode.startIndex - b.backgroundTree.rootNode.startIndex,
        )[0];
      const index =
        location === "first-owner-start"
          ? 0
          : location === "owner-end"
            ? text.indexOf("</script>") + "</script>".length
            : css.lastIncludedRanges[0].startIndex;
      const changes = [
        {
          startIndex: index,
          oldEndIndex: index,
          text: location === "content-start" ? "/* added */\n" : "<!-- added -->\n",
        },
      ];
      const parsed = recordPrivateParses(t);
      const mode = await fork(host, data, 2, changes);
      const fresh = await open(host, { ...data, session: 3, revision: 1 }, changed(text, changes));
      assert.deepEqual(forest(mode), forest(fresh), location);
      const children = parsed.filter(({ depth }) => depth > 0);
      assert.ok(children.length >= 2, location);
      assert.ok(
        children.every(({ previous }) => previous),
        `${location}: ${JSON.stringify(children.map(({ scope, previous }) => [scope, Boolean(previous)]))}`,
      );
    } finally {
      host.close();
      t.mock.restoreAll();
    }
  }
});

test("combined injections preserve holes and agree with a fresh parse after cell splits and merges", async () => {
  const text =
    "# %%\nclass First:\n    value = 1\n# %%\n%%html\n<section>red</section>\n# %%\nclass Second:\n    value = 2\n";
  for (const kind of ["hole", "split", "merge"]) {
    const { host, data } = await setup(text, [...ipythonFiles, "language-html/grammars/html.json"]);
    try {
      const index =
        kind === "hole"
          ? text.indexOf("red")
          : kind === "split"
            ? text.indexOf("    value = 2")
            : text.lastIndexOf("# %%\n");
      const change =
        kind === "hole"
          ? { startIndex: index, oldEndIndex: index + 3, text: "a much longer description" }
          : kind === "split"
            ? { startIndex: index, oldEndIndex: index, text: "# %%\n" }
            : { startIndex: index, oldEndIndex: index + "# %%\n".length, text: "" };
      const mode = await fork(host, data, 2, [change]);
      const fresh = await open(host, { ...data, session: 3, revision: 1 }, changed(text, [change]));
      assert.deepEqual(forest(mode), forest(fresh), kind);
      assert.equal(host.sessions.get(1).buffer.getText(), text);
    } finally {
      host.close();
    }
  }
});

test("forking before parent syntax catches up never labels stale injection trees as current", async (t) => {
  const text = "# %%\nclass First:\n    value = 1\n";
  const { host, data } = await setup(text, ipythonFiles);
  try {
    const mode = host.sessions.get(1).mode;
    const stale = mode.rootLanguageLayer.backgroundTree;
    const originalParse = mode.parseAsync;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    t.mock.method(mode, "shouldParseSynchronously", () => false);
    t.mock.method(mode, "parseAsync", async function (...args) {
      await gate;
      return originalParse.apply(this, args);
    });
    await host.dispatch("edit", {
      session: 1,
      beforeRevision: 9,
      revision: 10,
      changes: [{ startIndex: 0, oldEndIndex: 0, text: "# new\n" }],
    });
    try {
      mode.rootLanguageLayer.backgroundTree = stale;
      const parsed = recordPrivateParses(t);
      await host.dispatch("fork", { session: 1, revision: 10, target: 2 });
      await host.dispatch("initialize", { session: 2 });
      await host.dispatch("settle", { session: 2, revision: 0 });
      assert.ok(parsed.length >= 2);
      assert.ok(parsed.every(({ previous }) => !previous));
      const fresh = await open(host, { ...data, session: 3, revision: 0 }, "# new\n" + text);
      assert.deepEqual(forest(host.sessions.get(2).mode), forest(fresh));
    } finally {
      release();
      await host.dispatch("settle", { session: 1, revision: 10 });
    }
  } finally {
    host.close();
  }
});

test("a missing edit journal chain forces fresh root and injection parses", async (t) => {
  const text = "# %%\r\nclass First:\r\n    value = 1\r\n";
  const { host, data } = await setup(text, ipythonFiles);
  try {
    const parsed = recordPrivateParses(t);
    const original = host.installModeCurrent;
    t.mock.method(host, "installModeCurrent", function (session) {
      const result = original.call(this, session);
      if (session.parent) session.mode.document.clearHistory();
      return result;
    });
    const changes = [
      {
        startIndex: text.indexOf("First"),
        oldEndIndex: text.indexOf("First") + 5,
        text: "ChangedRecord",
      },
    ];
    const mode = await fork(host, data, 2, changes);
    const fresh = await open(host, { ...data, session: 3, revision: 1 }, changed(text, changes));
    assert.deepEqual(forest(mode), forest(fresh));
    assert.ok(parsed.length >= 2);
    assert.ok(
      parsed.every(({ previous }) => !previous),
      "No layer can guess offsets across missing journal history",
    );
  } finally {
    host.close();
  }
});

test("matching many sibling snapshots performs linear compatibility work", (t) => {
  const count = 1000;
  const source = Object.freeze({ length: count * 4 + 1 });
  const buffer = { getTextRevision: () => 9, getTextSnapshot: () => source };
  let generationReads = 0;
  let propertyReads = 0;
  const grammar = {
    getLanguageSync() {},
    get queryLoadGeneration() {
      generationReads++;
      return 0;
    },
  };
  const point = {
    get includeChildren() {
      propertyReads++;
      return true;
    },
  };
  const root = {
    grammar,
    grammarGeneration: 0,
    backgroundTree: { revision: 9, id: "root" },
    childLayerMarkers: new Set(),
    lastIncludedRanges: null,
  };
  const children = Array.from({ length: count }, (_, index) => {
    const range = Object.freeze({ startIndex: index * 4 + 1, endIndex: index * 4 + 3 });
    const marker = { parentLanguageLayer: root, languageString: "child", getRange: () => range };
    const layer = {
      grammar,
      grammarGeneration: 0,
      injectionPoint: point,
      marker,
      backgroundTree: { revision: 9, id: index },
      childLayerMarkers: new Set(),
      lastIncludedRanges: [range],
    };
    marker.languageLayer = layer;
    root.childLayerMarkers.add(marker);
    return layer;
  });
  const snapshot = SyntaxSnapshot.capture({ buffer, rootLanguageLayer: root });
  const receiver = snapshot.fork({ getTextSnapshot: () => source, getTextRevision: () => 0 });
  const copies = [];
  t.mock.method(Parser, "copySnapshot", (tree, revision) => {
    const copy = { source: tree.id, revision };
    copies.push(copy);
    return copy;
  });
  const mode = { document: { capture: (previous) => ({ previous, text: source, edits: [] }) } };
  const newRoot = { grammar };
  generationReads = 0;
  propertyReads = 0;
  try {
    assert.equal(receiver.claim(mode, newRoot, null).source, "root");
    for (let index = count - 1; index >= 0; index--) {
      const original = children[index];
      const layer = {
        grammar,
        injectionPoint: point,
        marker: {
          parentLanguageLayer: newRoot,
          languageString: "child",
          getRange: original.marker.getRange,
        },
      };
      assert.equal(receiver.claim(mode, layer, original.lastIncludedRanges).source, index);
    }
    assert.equal(copies.length, count + 1);
    assert.ok(
      generationReads <= count * 8,
      `Grammar compatibility was examined ${generationReads} times`,
    );
    assert.ok(
      propertyReads <= count * 8,
      `Injection properties were examined ${propertyReads} times`,
    );
  } finally {
    receiver.close();
  }
});

test("closing an uninitialized forest snapshot allocates no tree copies and leaves parent syntax usable", async (t) => {
  const text = "# %%\nclass First:\n    value = 1\n";
  const { host, data } = await setup(text, ipythonFiles);
  try {
    const mode = host.sessions.get(1).mode;
    const before = forest(mode);
    const copies = [];
    const original = Parser.copySnapshot;
    t.mock.method(Parser, "copySnapshot", function (...args) {
      const copy = original.apply(this, args);
      copies.push(copy);
      return copy;
    });
    await host.dispatch("fork", { ...data, target: 2 });
    const receiver = host.sessions.get(2).initialSyntaxSnapshot;
    assert.ok(receiver);
    const close = t.mock.method(receiver, "close");
    assert.equal(copies.length, 0, "Unused forest layers must not eagerly allocate WASM handles");
    host.closeSession(2);
    assert.equal(close.mock.callCount(), 1);
    assert.equal(host.sessions.size, 1);
    assert.deepEqual(forest(mode), before);
    await host.dispatch("prepared-indent", {
      ...data,
      target: 3,
      changes: [{ startIndex: text.indexOf(":"), oldEndIndex: text.indexOf(":"), text: " " }],
      ranges: [[1, 1]],
      tabLength: 4,
      inline: true,
      options: { isPastedText: false },
    });
    assert.equal(host.sessions.size, 1);
    assert.deepEqual(forest(mode), before);
    assert.ok(
      copies.every(
        (copy) => !mode.getAllLanguageLayers().some((layer) => layer.backgroundTree === copy),
      ),
    );
  } finally {
    host.close();
  }
});
