const CSON = require("@lumine-code/season");
const TextBuffer = require("../src/text-buffer");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");

describe("Tree-sitter combined injections", () => {
  let buffer, mode, grammars, registrations, javascript, point;

  function grammar(repository, filename, scopeName, injectionNames) {
    const file = require.resolve(`${repository}/grammars/${filename}`);
    const result = new TreeSitterGrammar(lumine.grammars, file, {
      ...CSON.readFileSync(file),
      scopeName,
      injectionNames,
    });
    grammars.push(result);
    registrations.push(lumine.grammars.addGrammar(result));
    return result;
  }

  async function start(source, root = javascript) {
    buffer = new TextBuffer({ text: source });
    mode = new TreeSitterLanguageMode({
      buffer,
      grammar: root,
      config: lumine.config,
      grammars: lumine.grammars,
      injectionCandidateChunkCodeUnits: 128,
      injectionReconcileChunkSize: 20,
    });
    buffer.setLanguageMode(mode);
    await mode.ready;
    await mode.atGrammarSettlement();
  }

  const layers = () =>
    mode.getAllInjectionLayers().filter((layer) => layer.injectionPoint === point);
  const contents = () =>
    layers()[0]
      ?.getCurrentRanges()
      .map((range) => buffer.getTextInRange(range)) ?? [];
  const scopesAt = (needle) =>
    mode
      .scopeDescriptorForPosition(
        buffer.positionForCharacterIndex(buffer.getText().indexOf(needle)),
      )
      .getScopesArray();
  async function replace(from, to) {
    const index = buffer.getText().indexOf(from);
    if (index < 0) throw new Error(`Missing source text: ${from}`);
    buffer.setTextInRange(
      [
        buffer.positionForCharacterIndex(index),
        buffer.positionForCharacterIndex(index + from.length),
      ],
      to,
    );
    await mode.atTransactionEnd();
  }

  beforeEach(() => {
    jasmine.useRealClock();
    grammars = [];
    registrations = [];
    javascript = grammar("language-javascript", "javascript.json", "source.audit-js", ["audit-js"]);
    grammar("language-regex", "regex.json", "source.audit-regex", [
      "audit-regex",
      "audit-regex-other",
    ]);
    point = {
      type: "regex_pattern",
      language: () => "audit-regex",
      content: (node) => node,
      combined: true,
      languageScope: null,
    };
    javascript.addInjectionPoint(point);
  });

  afterEach(() => {
    buffer?.destroy();
    for (const registration of registrations) registration.dispose();
    for (const item of grammars) item.subscriptions.dispose();
  });

  it("shares one parser without rediscovering untouched members on outside edits", async () => {
    const source = [
      "const marker = 0;",
      ...Array.from({ length: 1000 }, (_, i) => `const p${i} = /value${i}+/;`),
    ].join("\n");
    await start(source);
    expect(layers().length).toBe(1);
    const layer = layers()[0];
    spyOn(point, "language").and.callThrough();
    spyOn(point, "content").and.callThrough();
    spyOn(layer, "update").and.callThrough();
    await replace("0;", "1;");
    expect(point.language).not.toHaveBeenCalled();
    expect(point.content).not.toHaveBeenCalled();
    expect(layer.update).not.toHaveBeenCalled();
    expect(layers()[0]).toBe(layer);
    expect(contents().length).toBe(1000);
  });

  it("reuses the shared layer while locally replacing one member", async () => {
    await start("const a = /a+/;\nconst b = /b+/;\nconst c = /c+/;");
    const layer = layers()[0];
    spyOn(point, "language").and.callThrough();
    await replace("b+", "bb*");
    expect(layers()[0]).toBe(layer);
    expect(point.language).toHaveBeenCalledTimes(1);
    expect(contents()).toEqual(["a+", "bb*", "c+"]);
    expect(scopesAt("*")).toContain("keyword.operator.quantifier.regexp");
    expect(scopesAt("c+")).not.toContain("source.audit-regex");
  });

  it("preserves scopes compared with independent regex layers", async () => {
    const source = String.raw`const a = /^([a-z]+)$/; const b = /\bfoo|bar\b/;
const c = /(?<name>a+)\k<name>/; const d = /[\]\d]+\?/;`;
    point.combined = false;
    await start(source);
    const scopes = () =>
      Array.from(source, (_, index) =>
        mode.scopeDescriptorForPosition(buffer.positionForCharacterIndex(index)).getScopesArray(),
      );
    const independent = scopes();
    expect(layers().length).toBe(4);
    buffer.destroy();
    point.combined = true;
    await start(source);
    expect(layers().length).toBe(1);
    expect(scopes()).toEqual(independent);
  });

  it("adds and removes members at either end and retires the final group", async () => {
    await start("const a = /a+/;\nconst b = /b+/;");
    const layer = layers()[0];
    await replace("/a+/", "123");
    expect(contents()).toEqual(["b+"]);
    buffer.append("\nconst c = /c*/;");
    await mode.atTransactionEnd();
    expect(contents()).toEqual(["b+", "c*"]);
    expect(layers()[0]).toBe(layer);
    await replace("/b+/", "456");
    await replace("/c*/", "789");
    expect(layers().length).toBe(0);
    expect(mode.rootLanguageLayer.combinedInjectionMembersLayer.getMarkerCount()).toBe(0);
    expect(mode.rootLanguageLayer.combinedInjectionGroups.size).toBe(0);
  });

  it("tracks shifts before and between members without rebuilding their ranges", async () => {
    await start("let marker = 0;\nconst a = /a+/;\nlet value = 0;\nconst b = /b*/;");
    const layer = layers()[0];
    spyOn(point, "language").and.callThrough();
    spyOn(layer, "update").and.callThrough();
    buffer.insert([0, 0], "\n");
    await mode.atTransactionEnd();
    await replace("value = 0", "value = 1000");
    expect(point.language).not.toHaveBeenCalled();
    expect(layer.update).not.toHaveBeenCalled();
    expect(contents()).toEqual(["a+", "b*"]);
    expect(scopesAt("*")).toContain("keyword.operator.quantifier.regexp");
  });

  it("removes collapsed owner markers when the whole buffer is deleted", async () => {
    await start("const a = /a+/;\nconst b = /b*/;");
    buffer.setText("");
    await mode.atTransactionEnd();
    expect(layers().length).toBe(0);
    expect(mode.injectionsMarkerLayer.getMarkerCount()).toBe(0);
    expect(mode.rootLanguageLayer.combinedInjectionMembersLayer.getMarkerCount()).toBe(0);
  });

  it("rebuilds after removing and adding a registration", async () => {
    await start("const a = /a+/; const b = /b*/;");
    javascript.removeInjectionPoint(point);
    await mode.atGrammarSettlement();
    expect(layers().length).toBe(0);
    javascript.addInjectionPoint(point);
    await mode.atGrammarSettlement();
    expect(layers().length).toBe(1);
    expect(contents()).toEqual(["a+", "b*"]);
  });

  it("keeps language names and coterminous registrations in separate groups", async () => {
    point.language = (node) => (node.text.startsWith("a") ? "audit-regex" : "audit-regex-other");
    const second = {
      ...point,
      language: () => "audit-regex",
      languageScope: "source.audit-secondary",
    };
    javascript.addInjectionPoint(second);
    await start("const a = /a+/; const b = /b*/;");
    expect(layers().length).toBe(2);
    expect(
      mode.getAllInjectionLayers().filter((layer) => layer.injectionPoint === second).length,
    ).toBe(1);
    expect(scopesAt("+")).toContain("source.audit-secondary");
  });

  it("combines disjoint content while excluding children and preserving parent ranges", async () => {
    javascript.removeInjectionPoint(point);
    point = {
      type: "template_string",
      language: () => "audit-regex",
      content: (node) => node.children.filter((child) => child.type === "string_fragment"),
      combined: true,
      languageScope: null,
    };
    javascript.addInjectionPoint(point);
    await start("const a = `first${value}second`; const b = `third${other}fourth`;");
    expect(layers().length).toBe(1);
    expect(contents().join("")).not.toContain("value");
    expect(contents().join("")).not.toContain("other");
    await replace("value", "longerValue");
    expect(layers().length).toBe(1);
    expect(contents().join("")).not.toContain("longerValue");
  });

  it("joins line comments with newlines for multi-line documentation", async () => {
    javascript.removeInjectionPoint(point);
    point = {
      type: "comment",
      language: (node) => (node.text.startsWith("///") ? "audit-regex" : null),
      content: (node) => node,
      combined: true,
      newlinesBetween: true,
      languageScope: null,
    };
    javascript.addInjectionPoint(point);
    await start("/// first\nlet gap = 0;\n/// second\n/// third");
    expect(contents().join("")).toBe("/// first\n/// second\n/// third");
    await replace("/// second", "// ordinary");
    expect(contents().join("")).toBe("/// first\n/// third");
  });

  it("maintains combined leaves nested through HTML and EJS", async () => {
    const html = grammar("language-html", "html.json", "text.audit-html", ["audit-html"]);
    html.addInjectionPoint({
      type: "script_element",
      language: () => "audit-js",
      content: (node) => node.child(1),
    });
    const ejs = grammar("language-html", "ejs.json", "text.audit-ejs", []);
    ejs.addInjectionPoint({
      type: "template",
      language: () => "audit-html",
      content: (node) => node.descendantsOfType("content"),
    });
    await start(
      "<div>before</div>\n<script>const a = /a+/; const b = /b*/;</script>\n<% const x = 0; %>",
      ejs,
    );
    expect(layers().length).toBe(1);
    const layer = layers()[0];
    expect(layer.depth).toBe(3);
    await replace("a+", "aa?");
    expect(layers()[0]).toBe(layer);
    expect(contents()).toEqual(["aa?", "b*"]);
    expect(scopesAt("?")).toContain("keyword.operator.quantifier.regexp");
    await replace("/b*/", "123");
    expect(contents()).toEqual(["aa?"]);
  });

  it("recomputes joined whitespace when a gap stops being whitespace", async () => {
    javascript.removeInjectionPoint(point);
    point = { ...point, type: "comment", includeAdjacentWhitespace: true };
    javascript.addInjectionPoint(point);
    await start("/* first */  /* second */");
    expect(layers().length).toBe(1);
    expect(contents()).toEqual(["/* first */  /* second */"]);
    await replace("  ", " 0; ");
    expect(contents()).toEqual(["/* first */", "/* second */"]);
  });

  it("keeps the last committed group when a local content callback throws", async () => {
    await start("const a = /a+/;\nconst b = /b*/;");
    const layer = layers()[0];
    const members = mode.rootLanguageLayer.combinedInjectionMembersLayer.getMarkerCount();
    let calls = 0;
    spyOn(point, "content").and.callFake((node) => {
      if (++calls === 2) throw new Error("broken combined content");
      return node;
    });
    await expectAsync(
      mode.rootLanguageLayer._populateInjections(buffer.getRange(), null),
    ).toBeRejectedWithError("broken combined content");
    expect(layers()[0]).toBe(layer);
    expect(mode.rootLanguageLayer.combinedInjectionMembersLayer.getMarkerCount()).toBe(members);
  });

  it("discards prepared member markers when a yielded plan is superseded", async () => {
    let resume;
    const original = TreeSitterLanguageMode.prototype._yieldForInjectionReconcile;
    spyOn(TreeSitterLanguageMode.prototype, "_yieldForInjectionReconcile").and.callFake(
      function () {
        if (!resume)
          return new Promise((resolve) => {
            resume = resolve;
          });
        return original.call(this);
      },
    );
    const initializing = start(
      Array.from({ length: 40 }, (_, i) => `const p${i} = /value${i}+/;`).join("\n"),
    );
    while (!resume) await new Promise((resolve) => setTimeout(resolve, 0));
    buffer.setText("const final = /z+/;");
    resume();
    await initializing;
    await mode.atTransactionEnd();
    expect(layers().length).toBe(1);
    expect(contents()).toEqual(["z+"]);
    expect(mode.rootLanguageLayer.combinedInjectionMembersLayer.getMarkerCount()).toBe(2);
  });

  it("reevaluates grouped callbacks when their configuration requests a full rescan", async () => {
    let enabled = true;
    point.language = () => (enabled ? "audit-regex" : null);
    await start("const a = /a+/; const b = /b*/;");
    enabled = false;
    mode.repopulateInjections();
    await mode.atGrammarSettlement();
    expect(layers().length).toBe(0);
    enabled = true;
    mode.repopulateInjections();
    await mode.atGrammarSettlement();
    expect(contents()).toEqual(["a+", "b*"]);
  });
});
