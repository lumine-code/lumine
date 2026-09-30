const CSON = require("@lumine-code/season");
const TextBuffer = require("../src/text-buffer");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");

describe("Bounded combined Tree-sitter injections", () => {
  let buffer, mode, grammars, registrations, javascript, regex, point;

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

  function validRegex(node) {
    const pattern = node.childForFieldName("pattern")?.text;
    const flags = node.childForFieldName("flags")?.text ?? "";
    if (!pattern || flags.includes("v") || /\\[0-9]+$/.test(pattern)) return false;
    try {
      new RegExp(pattern, flags);
      if (!flags.includes("u")) new RegExp(pattern, `${flags}u`);
      return true;
    } catch {
      return false;
    }
  }

  async function start(source, root = javascript, options = {}) {
    buffer = new TextBuffer({ text: source });
    mode = new TreeSitterLanguageMode({
      buffer,
      grammar: root,
      config: lumine.config,
      grammars: lumine.grammars,
      ...options,
    });
    buffer.setLanguageMode(mode);
    await mode.ready;
    await mode.atGrammarSettlement();
  }

  const source = (count) =>
    Array.from({ length: count }, (_, i) => `const p${i} = /value${i}+/;`).join("\n");
  const layers = () =>
    mode.getAllInjectionLayers().filter((layer) => layer.injectionPoint === point);
  const groups = () =>
    layers()
      .map((layer) => layer.marker.combinedInjectionGroup)
      .filter(Boolean);
  const contentRanges = () =>
    layers()
      .flatMap((layer) => layer.getCurrentRanges())
      .sort((a, b) => a.compare(b));
  const contents = () => contentRanges().map((range) => buffer.getTextInRange(range));
  const groupFor = (text) =>
    groups().find((group) =>
      [...group.members].some((member) =>
        member.contentMarkers.some((marker) => buffer.getTextInRange(marker.getRange()) === text),
      ),
    );
  const expectBounded = () => {
    for (const group of groups())
      expect(group.members.size).toBeLessThanOrEqual(point.combinedMaxMembers);
  };

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

  async function expectIndependentScopes(root = javascript, rootRanges = null) {
    const original = point.combined;
    const freshBuffer = new TextBuffer({ text: buffer.getText() });
    const restriction =
      rootRanges && lumine.grammars.setRootLanguageRanges(freshBuffer, rootRanges);
    let fresh;
    try {
      point.combined = false;
      fresh = new TreeSitterLanguageMode({
        buffer: freshBuffer,
        grammar: root,
        config: lumine.config,
        grammars: lumine.grammars,
      });
      freshBuffer.setLanguageMode(fresh);
      await fresh.ready;
      await fresh.atGrammarSettlement();
      const actualRanges = contentRanges().map((range) => range.serialize());
      const expectedRanges = fresh
        .getAllInjectionLayers()
        .filter((layer) => layer.injectionPoint === point)
        .flatMap((layer) => layer.getCurrentRanges())
        .sort((a, b) => a.compare(b))
        .map((range) => range.serialize());
      expect(actualRanges).toEqual(expectedRanges);
      for (let index = 0; index < buffer.getLength(); index++) {
        const position = buffer.positionForCharacterIndex(index);
        expect(mode.scopeDescriptorForPosition(position).getScopesArray())
          .withContext(`at ${position.toString()}`)
          .toEqual(fresh.scopeDescriptorForPosition(position).getScopesArray());
      }
    } finally {
      point.combined = original;
      freshBuffer.destroy();
      restriction?.dispose();
    }
  }

  beforeEach(() => {
    jasmine.useRealClock();
    grammars = [];
    registrations = [];
    javascript = grammar("language-javascript", "javascript.json", "source.bounded-js", [
      "bounded-js",
    ]);
    regex = grammar("language-regex", "regex.json", "source.bounded-regex", [
      "bounded-regex",
      "bounded-regex-other",
    ]);
    point = {
      type: "regex",
      language: () => "bounded-regex",
      content: (node) => node.childForFieldName("pattern"),
      combined: validRegex,
      combinedMaxMembers: 4,
      languageScope: null,
    };
    javascript.addInjectionPoint(point);
  });

  afterEach(() => {
    buffer?.destroy();
    for (const registration of registrations) registration.dispose();
    for (const item of grammars) item.subscriptions.dispose();
  });

  it("caps owner counts below, at and above the limit, including same-line literals", async () => {
    for (const count of [3, 4, 5, 9]) {
      await start(source(count).replaceAll("\n", " "));
      expect(layers().length).toBe(Math.ceil(count / 4));
      expectBounded();
      expect(contents().length).toBe(count);
      await expectIndependentScopes();
      buffer.destroy();
    }
  });

  it("supports a one-member cap and retains unlimited grouping by default", async () => {
    point.combinedMaxMembers = 1;
    await start(source(5));
    expect(layers().length).toBe(5);
    expectBounded();
    buffer.destroy();
    delete point.combinedMaxMembers;
    await start(source(9));
    expect(layers().length).toBe(1);
    expect(contents().length).toBe(9);
  });

  it("preserves the member group, shared layer, parser ranges and range markers on a same-length edit", async () => {
    await start(source(9));
    const originalGroups = groups();
    const group = groupFor("value1+");
    const layer = group.marker.languageLayer;
    const ranges = layer.lastIncludedRanges;
    const markers = layer.currentRangesLayer.getMarkers();
    for (const item of layers()) spyOn(item, "update").and.callThrough();
    spyOn(point, "language").and.callThrough();
    await replace("value1+", "value1*");
    expect(groupFor("value1*")).toBe(group);
    expect(groups()).toEqual(originalGroups);
    expect(layer.lastIncludedRanges).toBe(ranges);
    expect(layer.currentRangesLayer.getMarkers()).toEqual(markers);
    expect(point.language).toHaveBeenCalledTimes(1);
    expect(layer.update).toHaveBeenCalledTimes(1);
    for (const other of layers().filter((item) => item !== layer))
      expect(other.update).not.toHaveBeenCalled();
    await expectIndependentScopes();
  });

  it("splits only a full local group and preserves its untouched neighbor", async () => {
    await start(source(8));
    const original = groupFor("value0+");
    const untouched = groupFor("value7+");
    const untouchedLayer = untouched.marker.languageLayer;
    await replace("const p1 = /value1+/;", "const p1 = /value1+/;\nconst added = /added*/;");
    expect(layers().length).toBe(3);
    expect(groups()).toContain(original);
    expect(groupFor("value7+")).toBe(untouched);
    expect(untouched.marker.languageLayer).toBe(untouchedLayer);
    expectBounded();
    expect(contents().length).toBe(9);
    await expectIndependentScopes();
  });

  it("merges adjacent groups after deletion and releases the discarded layer query", async () => {
    await start(source(6));
    const retained = groupFor("value0+").marker.languageLayer;
    const discarded = groupFor("value5+").marker.languageLayer;
    const query = retained.queries.highlightsQuery;
    expect(regex.queryReferenceCounts.get(query)).toBe(3);
    await replace("/value3+/", "0");
    expect(layers().length).toBe(2);
    await replace("/value2+/", "0");
    expect(layers()).toEqual([retained]);
    expect(discarded.destroyed).toBe(true);
    expect(regex.queryReferenceCounts.get(query)).toBe(2);
    expectBounded();
    await expectIndependentScopes();
  });

  it("avoids one-layer-per-survivor fragmentation through adversarial insertion and deletion", async () => {
    await start(source(24));
    for (let i = 0; i < 24; i += 4)
      await replace(`const p${i} =`, `const fresh${i} = /fresh${i}*/;\nconst p${i} =`);
    for (let i = 0; i < 24; i++) await replace(`const p${i} = /value${i}+/;`, "");
    expect(contents().length).toBe(6);
    expect(layers().length).toBeLessThanOrEqual(3);
    expectBounded();
    await expectIndependentScopes();
  });

  it("keeps stable memberships through prefix shifts, then handles first and last insertion", async () => {
    await start(source(8));
    const original = new Map(contents().map((text) => [text, groupFor(text)]));
    buffer.insert([0, 0], "\n// heading\n");
    await mode.atTransactionEnd();
    for (const [text, group] of original) expect(groupFor(text)).toBe(group);
    buffer.insert([0, 0], "const first = /first*/;\n");
    await mode.atTransactionEnd();
    buffer.append("\nconst last = /last?/;");
    await mode.atTransactionEnd();
    expectBounded();
    expect(contents().length).toBe(10);
    await expectIndependentScopes();
  });

  it("removes empty first groups and disposes the last group and all owner markers", async () => {
    await start(source(9));
    const first = groupFor("value0+").marker.languageLayer;
    for (let i = 0; i < 4; i++) await replace(`/value${i}+/`, "0");
    expect(first.destroyed).toBe(true);
    expect(layers().length).toBe(2);
    for (let i = 4; i < 9; i++) await replace(`/value${i}+/`, "0");
    expect(layers().length).toBe(0);
    expect(mode.rootLanguageLayer.combinedInjectionGroups.size).toBe(0);
    expect(mode.rootLanguageLayer.combinedInjectionMembersLayer.getMarkerCount()).toBe(0);
    expect(mode.injectionsMarkerLayer.getMarkerCount()).toBe(0);
  });

  it("cleans all collapsed groups when the entire buffer is deleted", async () => {
    await start(source(17));
    const oldLayers = layers();
    buffer.setText("");
    await mode.atTransactionEnd();
    expect(layers().length).toBe(0);
    expect(oldLayers.every((layer) => layer.destroyed)).toBe(true);
    expect(mode.injectionsMarkerLayer.getMarkerCount()).toBe(0);
    expect(mode.rootLanguageLayer.combinedInjectionMembersLayer.getMarkerCount()).toBe(0);
  });

  it("counts owners rather than the fragments returned by each owner", async () => {
    javascript.removeInjectionPoint(point);
    point = {
      ...point,
      type: "template_string",
      combined: true,
      combinedMaxMembers: 2,
      content: (node) => node.children.filter((child) => child.type === "string_fragment"),
    };
    javascript.addInjectionPoint(point);
    await start(Array.from({ length: 5 }, (_, i) => `const p${i} = \`a+\${${i}}b*\`;`).join("\n"));
    expect(layers().length).toBe(3);
    expect(groups().map((group) => group.members.size)).toEqual([2, 2, 1]);
    expect(contents().length).toBe(10);
    await expectIndependentScopes();
  });

  it("preserves independent scopes through validity and flag transitions across a group boundary", async () => {
    await start(source(6));
    for (const pattern of ["(", String.raw`\x`, String.raw`(a)\1`, "value3+"]) {
      const original = buffer.lineForRow(3);
      await replace(original, `const p3 = /${pattern}/;`);
      expectBounded();
      await expectIndependentScopes();
    }
    const valid = point.combined;
    point.combined = (node) => valid(node) && node.childForFieldName("flags")?.text !== "i";
    await replace("/value3+/", "/value3+/i");
    expect(layers().some((layer) => !layer.marker.combinedInjectionGroup)).toBe(true);
    await expectIndependentScopes();
    await replace("/value3+/i", "/value3+/u");
    expect(layers().every((layer) => layer.marker.combinedInjectionGroup)).toBe(true);
    expectBounded();
    await expectIndependentScopes();
  });

  it("keeps different language aliases and coterminous injection points in separate bounded pools", async () => {
    point.language = (node) =>
      /[02468]\+$/.test(node.childForFieldName("pattern").text)
        ? "bounded-regex"
        : "bounded-regex-other";
    point.combinedMaxMembers = 2;
    const second = {
      ...point,
      language: () => "bounded-regex",
      languageScope: "source.bounded-secondary",
    };
    javascript.addInjectionPoint(second);
    await start(source(7));
    expect(layers().length).toBe(4);
    expect(
      mode.getAllInjectionLayers().filter((layer) => layer.injectionPoint === second).length,
    ).toBe(4);
    expectBounded();
    await expectIndependentScopes();
  });

  it("retains parent clipping through nested EJS, HTML and JavaScript edits", async () => {
    point.combinedMaxMembers = 2;
    const html = grammar("language-html", "html.json", "text.bounded-html", ["bounded-html"]);
    html.addInjectionPoint({
      type: "script_element",
      language: () => "bounded-js",
      content: (node) => node.child(1),
    });
    const ejs = grammar("language-html", "ejs.json", "text.bounded-ejs", []);
    ejs.addInjectionPoint({
      type: "template",
      language: () => "bounded-html",
      content: (node) => node.descendantsOfType("content"),
    });
    await start(`<div>outside</div>\n<script>${source(5)}</script>\n<% const x = 0; %>`, ejs);
    expect(layers().length).toBe(3);
    expect(layers().every((layer) => layer.depth === 3)).toBe(true);
    await replace("value1+", "value1*");
    expectBounded();
    await expectIndependentScopes(ejs);
    await replace("const p3 = /value3+/;", "const p3 = /value3+/; const added = /added*/;");
    expectBounded();
    await expectIndependentScopes(ejs);
    expect(mode.scopeDescriptorForPosition([0, 5]).getScopesArray()).not.toContain(
      "keyword.operator.quantifier.regexp",
    );
  });

  it("rebuilds all bounded pools after registration changes and changed limits", async () => {
    await start(source(9));
    const old = layers();
    javascript.removeInjectionPoint(point);
    await mode.atGrammarSettlement();
    expect(layers().length).toBe(0);
    expect(old.every((layer) => layer.destroyed)).toBe(true);
    point.combinedMaxMembers = 2;
    javascript.addInjectionPoint(point);
    await mode.atGrammarSettlement();
    expect(layers().length).toBe(5);
    expectBounded();
    await expectIndependentScopes();
  });

  it("applies a changed limit to retained owners and can return to one unlimited group", async () => {
    await start(source(9));
    const retained = groupFor("value0+").marker.languageLayer;
    point.combinedMaxMembers = 1;
    mode.repopulateInjections();
    await mode.atGrammarSettlement();
    expect(layers().length).toBe(9);
    expect(layers()).toContain(retained);
    expectBounded();
    delete point.combinedMaxMembers;
    mode.repopulateInjections();
    await mode.atGrammarSettlement();
    expect(layers()).toEqual([retained]);
    expect(contents().length).toBe(9);
    await expectIndependentScopes();
  });

  it("recovers after aborted child initialization replaces every old owner", async () => {
    const load = spyOn(regex, "getQuery").and.callFake(() =>
      Promise.reject(Object.assign(new Error("cancelled generation"), { name: "AbortError" })),
    );
    await start(source(9));
    expect(layers().length).toBe(0);
    load.and.callThrough();
    buffer.setText(source(9).replaceAll("value", "fresh"));
    await mode.atTransactionEnd();
    expect(layers().length).toBe(3);
    expect(contents().length).toBe(9);
    expectBounded();
    await expectIndependentScopes();
  });

  it("disposes every bounded group when its grammar disappears and uses a replacement alias target", async () => {
    await start(source(9));
    const original = layers();
    const query = original[0].queries.highlightsQuery;
    registrations[1].dispose();
    // These standalone buffers are not registered editor models. Request the
    // same rescan that GrammarRegistry dispatches to registered editors.
    mode.repopulateInjections();
    await mode.atGrammarSettlement();
    expect(layers().length).toBe(0);
    expect(original.every((layer) => layer.destroyed)).toBe(true);
    expect(regex.queryReferenceCounts.get(query)).toBe(1);
    const replacement = grammar("language-regex", "regex.json", "source.bounded-replacement", [
      "bounded-regex",
    ]);
    mode.repopulateInjections();
    await mode.atGrammarSettlement();
    expect(layers().length).toBe(3);
    expect(layers().every((layer) => layer.grammar === replacement)).toBe(true);
    expectBounded();
    await expectIndependentScopes();
  });

  it("clips bounded content to a restricted root and retains groups when the root mask shifts", async () => {
    point.content = (node) => {
      const pattern = node.childForFieldName("pattern");
      return pattern.text === "value0+"
        ? {
            startIndex: 0,
            startPosition: { row: 0, column: 0 },
            endIndex: pattern.endIndex,
            endPosition: pattern.endPosition,
          }
        : pattern;
    };
    const provider = (sourceBuffer) => {
      const index = sourceBuffer.getText().indexOf("const p0");
      return index < 0
        ? []
        : [[sourceBuffer.positionForCharacterIndex(index), sourceBuffer.getEndPosition()]];
    };
    await start(`// excluded + header\n${source(8)}`);
    registrations.push(lumine.grammars.setRootLanguageRanges(buffer, provider));
    await mode.atGrammarSettlement();
    const original = groups();
    expect(contentRanges()[0].start.toArray()).toEqual([1, 0]);
    await expectIndependentScopes(javascript, provider);
    buffer.insert([0, 0], "// shifted prefix\n");
    await mode.atTransactionEnd();
    expect(groups()).toEqual(original);
    expect(contentRanges()[0].start.toArray()).toEqual([2, 0]);
    expect(mode.scopeDescriptorForPosition([0, 3]).getScopesArray()).not.toContain(
      "source.bounded-js",
    );
    expectBounded();
    await expectIndependentScopes(javascript, provider);
  });

  it("keeps committed groups and discards provisional markers if a content callback throws", async () => {
    await start(source(9));
    const old = groups();
    const count = mode.rootLanguageLayer.combinedInjectionMembersLayer.getMarkerCount();
    let calls = 0;
    spyOn(point, "content").and.callFake((node) => {
      if (++calls === 3) throw new Error("broken bounded content");
      return node.childForFieldName("pattern");
    });
    await expectAsync(
      mode.rootLanguageLayer._populateInjections(buffer.getRange(), null),
    ).toBeRejectedWithError("broken bounded content");
    expect(groups()).toEqual(old);
    expect(mode.rootLanguageLayer.combinedInjectionMembersLayer.getMarkerCount()).toBe(count);
  });

  it("discards all unpublished groups when the parent plan is superseded", async () => {
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
    const initializing = start(source(25), javascript, { injectionReconcileChunkSize: 2 });
    while (!resume) await new Promise((resolve) => setTimeout(resolve, 0));
    buffer.setText("const final = /z+/;");
    resume();
    await initializing;
    await mode.atTransactionEnd();
    expect(layers().length).toBe(1);
    expect(contents()).toEqual(["z+"]);
    expect(mode.rootLanguageLayer.combinedInjectionMembersLayer.getMarkerCount()).toBe(2);
    expectBounded();
  });
});
