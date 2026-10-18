const TextBuffer = require("../src/text-buffer");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");
const CSON = require("@lumine-code/season");
const Native = require("@lumine-code/node-tree-sitter");
const scheduler = require("../src/tree-sitter-scheduler");
const grammarPath = require.resolve("language-javascript/grammars/javascript.json");

describe("Native Tree-sitter document snapshots", () => {
  let buffer, grammar, mode;
  beforeEach(() => {
    jasmine.useRealClock();
    const config = CSON.readFileSync(grammarPath);
    grammar = new TreeSitterGrammar(lumine.grammars, grammarPath, {
      ...config,
      treeSitter: { ...config.treeSitter, injectionsQuery: [] },
    });
    buffer = new TextBuffer();
  });
  afterEach(() => {
    buffer.destroy();
    grammar.deactivate();
  });
  function begin(text) {
    buffer.setText(text);
    mode = new TreeSitterLanguageMode({ buffer, grammar, grammars: lumine.grammars });
    buffer.setLanguageMode(mode);
    return mode;
  }
  async function start(text) {
    begin(text);
    await mode.ready;
    await mode.atGrammarSettlement();
    return mode.tree;
  }

  it("loads the pinned native backend and preserves old nodes and cursors", async () => {
    const tree = await start('const café = "🦉";\r\n');
    expect(tree instanceof Native.Tree).toBe(true);
    const node = tree.rootNode,
      cursor = node.walk(),
      revision = tree.revision;
    buffer.insert([0, 0], "// header\r\n");
    expect(mode.tree).not.toBe(tree);
    await mode.atGrammarSettlement();
    expect(mode.tree.revision).toBe(buffer.getTextRevision());
    expect(mode.tree.input).toBe(buffer.getText());
    expect(mode.tree.rootNode.hasError).toBe(false);
    expect(node.text).toBe('const café = "🦉";\r\n');
    expect(cursor.nodeText).toBe(node.text);
    expect(tree.revision).toBe(revision);
  });

  it("consumes sequential edits, undo, redo and rollback revisions", async () => {
    await start("let one = 1;\r\nlet two = 2;\r\n");
    buffer.transact(() => {
      buffer.insert([0, 0], "// \ud800\n");
      buffer.setTextInRange(
        [
          [1, 4],
          [1, 7],
        ],
        "longName",
      );
    });
    await mode.atGrammarSettlement();
    const updated = buffer.getText();
    expect(mode.tree.input).toBe(updated);
    buffer.undo();
    await mode.atGrammarSettlement();
    expect(mode.tree.input).toBe(buffer.getText());
    buffer.redo();
    await mode.atGrammarSettlement();
    expect(mode.tree.input).toBe(updated);
    const checkpoint = buffer.createCheckpoint();
    buffer.append("trailing;");
    buffer.revertToCheckpoint(checkpoint);
    await mode.atGrammarSettlement();
    expect(mode.tree.input).toBe(updated);
    expect(mode.tree.revision).toBe(buffer.getTextRevision());
  });

  it("keeps readiness pending when an early edit starts the initial update", async () => {
    await grammar.getLanguage();
    await grammar.getQuery("highlightsQuery");
    begin("before;");
    buffer.setText("const after = 1;");
    await mode.ready;
    expect(mode.tree).not.toBeNull();
    expect(mode.tree.input).toBe(buffer.getText());
    expect(mode.tree.revision).toBe(buffer.getTextRevision());
    expect(mode.rootLanguageLayer.updating).toBe(false);
    expect(mode.synchronousUpdates).toBe(true);
  });

  it("discards an initial asynchronous result delayed across another revision", async () => {
    begin("before;");
    const original = mode.parseAsync.bind(mode);
    let release, started;
    const entered = new Promise((resolve) => {
      started = resolve;
    });
    let delay = true;
    spyOn(mode, "parseAsync").and.callFake(async (...args) => {
      const tree = await original(...args);
      if (delay) {
        delay = false;
        started();
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      return tree;
    });
    const published = [];
    mode.onDidChangeHighlighting(() => {
      if (mode.tree) published.push([mode.tree.revision, mode.tree.input]);
    });
    await entered;
    buffer.setText("after;");
    release();
    await mode.atGrammarSettlement();
    expect(mode.tree.input).toBe("after;");
    expect(published.length).toBeGreaterThan(0);
    expect(
      published.every(
        ([revision, text]) => revision === buffer.getTextRevision() && text === "after;",
      ),
    ).toBe(true);
  });

  it("closing the buffer settles pending native work without publication", async () => {
    begin("const value = 1;\n".repeat(20000));
    const changed = jasmine.createSpy("changed");
    mode.onDidChangeHighlighting(changed);
    const parse = mode.parseAsync.bind(mode);
    let started;
    const entered = new Promise((resolve) => {
      started = resolve;
    });
    spyOn(mode, "parseAsync").and.callFake((language, previous, ranges, options) =>
      parse(language, previous, ranges, {
        ...options,
        onStart() {
          options.onStart?.();
          started();
        },
      }),
    );
    await entered;
    buffer.destroy();
    await mode.ready;
    expect(changed).not.toHaveBeenCalled();
  });

  it("keeps queued parser ranges paired with their original input revision", async () => {
    await start("// header\nconst original = 1;\n");
    const previous = mode.tree;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const blockers = Array.from({ length: scheduler.concurrency }, () => scheduler.run(() => gate));
    const ranges = [
      {
        startIndex: 10,
        endIndex: previous.input.length,
        startPosition: { row: 1, column: 0 },
        endPosition: { row: 2, column: 0 },
      },
    ];
    const pending = mode.parseAsync(grammar.getLanguageSync(), previous, ranges);
    buffer.setText("short;");
    release();
    try {
      const snapshot = await pending;
      expect(snapshot.input).toBe(previous.input);
      expect(snapshot.revision).toBe(previous.revision);
      expect(snapshot.rootNode.text).toBe("const original = 1;\n");
      expect(mode.tree.input).toBe("short;");
    } finally {
      release();
      await Promise.all(blockers);
    }
  });
});
