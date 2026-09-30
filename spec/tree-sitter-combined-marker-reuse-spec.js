const CSON = require("@lumine-code/season");
const TextBuffer = require("../src/text-buffer");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");

describe("Combined injection owner/content marker reuse", () => {
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

  async function start(source, root = javascript) {
    buffer = new TextBuffer({ text: source });
    mode = new TreeSitterLanguageMode({
      buffer,
      grammar: root,
      config: lumine.config,
      grammars: lumine.grammars,
    });
    buffer.setLanguageMode(mode);
    await mode.ready;
    await mode.atGrammarSettlement();
  }

  const source = (count) =>
    Array.from({ length: count }, (_, i) => `const p${i} = /value${i}+/;`).join("\n");
  const layers = () =>
    mode.getAllInjectionLayers().filter((layer) => layer.injectionPoint === point);
  const members = () =>
    layers().flatMap((layer) => [...layer.marker.combinedInjectionGroup.members]);
  const memberLayer = () => mode.rootLanguageLayer.combinedInjectionMembersLayer;
  const contents = () =>
    layers()
      .flatMap((layer) => layer.getCurrentRanges())
      .sort((a, b) => a.compare(b))
      .map((range) => buffer.getTextInRange(range));

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

  async function expectUnsharedScopes(root = javascript, provider = null) {
    const prototype = mode.rootLanguageLayer.constructor.prototype;
    const original = prototype._prepareCombinedInjectionMember;
    const freshBuffer = new TextBuffer({ text: buffer.getText() });
    const restriction = provider && lumine.grammars.setRootLanguageRanges(freshBuffer, provider);
    // Restore the old physical-marker arrangement while keeping the actual
    // parser, group topology, query identity and logical-document continuity.
    prototype._prepareCombinedInjectionMember = function (...args) {
      const member = original.apply(this, args);
      if (member?.contentMarkers.length === 1 && member.contentMarkers[0] === member.marker) {
        member.contentMarkers = [
          this.combinedInjectionMembersLayer.markRange(member.marker.getRange()),
        ];
      }
      return member;
    };
    try {
      const fresh = new TreeSitterLanguageMode({
        buffer: freshBuffer,
        grammar: root,
        config: lumine.config,
        grammars: lumine.grammars,
      });
      freshBuffer.setLanguageMode(fresh);
      await fresh.ready;
      await fresh.atGrammarSettlement();
      const ranges = (languageMode) =>
        languageMode
          .getAllInjectionLayers()
          .filter((layer) => layer.injectionPoint === point)
          .flatMap((layer) => layer.getCurrentRanges())
          .sort((a, b) => a.compare(b))
          .map((range) => range.serialize());
      expect(ranges(mode)).toEqual(ranges(fresh));
      for (let index = 0; index < buffer.getLength(); index++) {
        const position = buffer.positionForCharacterIndex(index);
        expect(mode.scopeDescriptorForPosition(position).getScopesArray())
          .withContext(`at ${position.toString()}`)
          .toEqual(fresh.scopeDescriptorForPosition(position).getScopesArray());
      }
    } finally {
      prototype._prepareCombinedInjectionMember = original;
      freshBuffer.destroy();
      restriction?.dispose();
    }
  }

  beforeEach(() => {
    jasmine.useRealClock();
    grammars = [];
    registrations = [];
    javascript = grammar("language-javascript", "javascript.json", "source.marker-js", [
      "marker-js",
    ]);
    regex = grammar("language-regex", "regex.json", "source.marker-regex", ["marker-regex"]);
    point = {
      type: "regex_pattern",
      language: () => "marker-regex",
      content: (node) => node,
      combined: true,
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

  it("uses one physical marker per exact owner/content pair without sharing between members", async () => {
    await start(source(40));
    expect(memberLayer().getMarkerCount()).toBe(40);
    expect(new Set(members().map((member) => member.marker)).size).toBe(40);
    for (const member of members()) {
      expect(member.contentMarkers).toEqual([member.marker]);
      expect(member.marker.isExclusive()).toBe(false);
      expect(member.marker.getInvalidationStrategy()).toBe("overlap");
    }
  });

  it("keeps separate markers when an owner's content range differs", async () => {
    javascript.removeInjectionPoint(point);
    point = { ...point, type: "regex", content: (node) => node.childForFieldName("pattern") };
    javascript.addInjectionPoint(point);
    await start(source(3));
    expect(memberLayer().getMarkerCount()).toBe(6);
    expect(members().every((member) => member.contentMarkers[0] !== member.marker)).toBe(true);
    await expectUnsharedScopes();
  });

  it("shares a coalesced span of multiple children only after computing its final range", async () => {
    javascript.removeInjectionPoint(point);
    point = { ...point, type: "string", content: (node) => node.children, includeChildren: true };
    javascript.addInjectionPoint(point);
    await start('const value = "ab+";');
    expect(members().length).toBe(1);
    expect(members()[0].contentMarkers).toEqual([members()[0].marker]);
    expect(memberLayer().getMarkerCount()).toBe(1);
    await expectUnsharedScopes();
  });

  it("does not mistake child-subtracted content for its original owner", async () => {
    javascript.removeInjectionPoint(point);
    point = { ...point, type: "call_expression", content: (node) => node };
    javascript.addInjectionPoint(point);
    await start("fn (value);");
    expect(contents()).toEqual([" "]);
    expect(memberLayer().getMarkerCount()).toBe(2);
    expect(members()[0].contentMarkers[0]).not.toBe(members()[0].marker);
    await expectUnsharedScopes();
  });

  it("keeps multiple disjoint fragments separate even if one equals the owner", async () => {
    point.content = (node) => [node, node.tree.rootNode.descendantsOfType("comment")[0]];
    await start("// external\nconst value = /ab+/;");
    expect(memberLayer().getMarkerCount()).toBe(3);
    expect(members()[0].contentMarkers.length).toBe(2);
    expect(members()[0].contentMarkers.every((marker) => marker !== members()[0].marker)).toBe(
      true,
    );
    await expectUnsharedScopes();
  });

  it("follows prefix and inclusive boundary insertions like an independent marker", async () => {
    await start("const value = /abc+/;");
    const member = members()[0];
    const controlLayer = buffer.addMarkerLayer();
    const control = controlLayer.markRange(member.marker.getRange());
    buffer.insert(member.marker.getRange().start, "x");
    await mode.atTransactionEnd();
    expect(members()[0]).toBe(member);
    expect(member.marker.getRange()).toEqual(control.getRange());
    buffer.insert(member.marker.getRange().end, "?");
    await mode.atTransactionEnd();
    expect(members()[0]).toBe(member);
    expect(member.marker.getRange()).toEqual(control.getRange());
    buffer.insert([0, 0], "// heading\n");
    await mode.atTransactionEnd();
    expect(members()[0]).toBe(member);
    expect(member.marker.getRange()).toEqual(control.getRange());
    expect(member.contentMarkers[0]).toBe(member.marker);
    await expectUnsharedScopes();
    controlLayer.destroy();
  });

  it("preserves shared identity and serialized ranges on a same-length edit", async () => {
    await start(source(5));
    const member = members().find(
      (item) => buffer.getTextInRange(item.marker.getRange()) === "value1+",
    );
    const layer = member.group.marker.languageLayer;
    const ranges = layer.lastIncludedRanges;
    const current = layer.currentRangesLayer.getMarkers();
    await replace("value1+", "value1*");
    expect(members()).toContain(member);
    expect(member.contentMarkers[0]).toBe(member.marker);
    expect(layer.lastIncludedRanges).toBe(ranges);
    expect(layer.currentRangesLayer.getMarkers()).toEqual(current);
    expect(memberLayer().getMarkerCount()).toBe(5);
    await expectUnsharedScopes();
  });

  it("replaces shared markers when content splits and can return to sharing", async () => {
    await start("const value = /abcdef+/;");
    const shared = members()[0].marker;
    spyOn(shared, "destroy").and.callThrough();
    const layer = layers()[0];
    point.content = (node) => [
      {
        startIndex: node.startIndex,
        endIndex: node.startIndex + 2,
        startPosition: node.startPosition,
        endPosition: buffer.positionForCharacterIndex(node.startIndex + 2),
      },
      {
        startIndex: node.startIndex + 4,
        endIndex: node.endIndex,
        startPosition: buffer.positionForCharacterIndex(node.startIndex + 4),
        endPosition: node.endPosition,
      },
    ];
    mode.repopulateInjections();
    await mode.atGrammarSettlement();
    expect(shared.destroy).toHaveBeenCalledTimes(1);
    expect(layers()).toEqual([layer]);
    expect(memberLayer().getMarkerCount()).toBe(3);
    expect(contents()).toEqual(["ab", "ef+"]);
    point.content = (node) => node;
    mode.repopulateInjections();
    await mode.atGrammarSettlement();
    expect(memberLayer().getMarkerCount()).toBe(1);
    expect(members()[0].contentMarkers[0]).toBe(members()[0].marker);
    expect(contents()).toEqual(["abcdef+"]);
    await expectUnsharedScopes();
  });

  it("preserves shared owners through bounded split and merge", async () => {
    await start(source(6));
    await replace("const p1 = /value1+/;", "const p1 = /value1+/;\nconst added = /added*/;");
    expect(memberLayer().getMarkerCount()).toBe(7);
    for (const member of members()) {
      expect(member.contentMarkers[0]).toBe(member.marker);
      expect(member.group.members.size).toBeLessThanOrEqual(4);
    }
    await replace("/value1+/", "0");
    await replace("/value2+/", "0");
    expect(memberLayer().getMarkerCount()).toBe(5);
    expect(members().every((member) => member.contentMarkers[0] === member.marker)).toBe(true);
    await expectUnsharedScopes();
  });

  it("destroys collapsed shared owners once and removes every role", async () => {
    await start(source(3));
    const old = members().map((member) => member.marker);
    for (const marker of old) spyOn(marker, "destroy").and.callThrough();
    buffer.setText("");
    await mode.atTransactionEnd();
    expect(layers().length).toBe(0);
    expect(memberLayer().getMarkerCount()).toBe(0);
    for (const marker of old) {
      expect(marker.isDestroyed()).toBe(true);
      expect(marker.destroy).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps coterminous registrations independent and removes only the requested owners", async () => {
    const second = { ...point };
    javascript.addInjectionPoint(second);
    await start(source(2));
    expect(memberLayer().getMarkerCount()).toBe(4);
    const other = mode
      .getAllInjectionLayers()
      .filter((layer) => layer.injectionPoint === second)
      .flatMap((layer) => [...layer.marker.combinedInjectionGroup.members]);
    expect(
      other.every((member) => !members().some((first) => first.marker === member.marker)),
    ).toBe(true);
    javascript.removeInjectionPoint(point);
    await mode.atGrammarSettlement();
    expect(memberLayer().getMarkerCount()).toBe(2);
    expect(other.every((member) => !member.marker.isDestroyed())).toBe(true);
  });

  it("disposes shared owners on grammar removal and uses fresh owners for a replacement target", async () => {
    await start(source(5));
    const old = members();
    const query = layers()[0].queries.highlightsQuery;
    registrations[1].dispose();
    mode.repopulateInjections();
    await mode.atGrammarSettlement();
    expect(memberLayer().getMarkerCount()).toBe(0);
    expect(old.every((member) => member.marker.isDestroyed())).toBe(true);
    expect(regex.queryReferenceCounts.get(query)).toBe(1);
    const replacement = grammar("language-regex", "regex.json", "source.marker-replacement", [
      "marker-regex",
    ]);
    mode.repopulateInjections();
    await mode.atGrammarSettlement();
    expect(memberLayer().getMarkerCount()).toBe(5);
    expect(layers().every((layer) => layer.grammar === replacement)).toBe(true);
    expect(members().every((member) => member.contentMarkers[0] === member.marker)).toBe(true);
    await expectUnsharedScopes();
  });

  it("shares raw owner ranges while clipping parser content to disjoint root ranges", async () => {
    await start("const value = /abcdef+/;");
    const provider = (sourceBuffer) => {
      const gap = sourceBuffer.getText().indexOf("/ab") + 3;
      return [
        [[0, 0], sourceBuffer.positionForCharacterIndex(gap)],
        [sourceBuffer.positionForCharacterIndex(gap + 2), sourceBuffer.getEndPosition()],
      ];
    };
    registrations.push(lumine.grammars.setRootLanguageRanges(buffer, provider));
    await mode.atGrammarSettlement();
    expect(memberLayer().getMarkerCount()).toBe(1);
    expect(members()[0].contentMarkers[0]).toBe(members()[0].marker);
    expect(contents()).toEqual(["ab", "ef+"]);
    await expectUnsharedScopes(javascript, provider);
    await replace("cd", "xy");
    expect(contents()).toEqual(["ab", "ef+"]);
    await expectUnsharedScopes(javascript, provider);
  });

  it("preserves a continuous logical document across shared comment markers", async () => {
    javascript.removeInjectionPoint(point);
    point = {
      type: "comment",
      language: () => "marker-regex",
      content: (node) => node,
      combined: true,
      newlinesBetween: true,
      languageScope: null,
    };
    javascript.addInjectionPoint(point);
    await start("// (\n// value+\n// )\nconst value = 0;");
    expect(layers().length).toBe(1);
    expect(memberLayer().getMarkerCount()).toBe(3);
    expect(members().every((member) => member.contentMarkers[0] === member.marker)).toBe(true);
    expect(mode.scopeDescriptorForPosition([1, 4]).getScopesArray()).toContain(
      "meta.group.capturing.regexp",
    );
    await expectUnsharedScopes();
    await replace("value+", "longer_value+");
    expect(layers().length).toBe(1);
    expect(memberLayer().getMarkerCount()).toBe(3);
    expect(mode.scopeDescriptorForPosition([1, 4]).getScopesArray()).toContain(
      "meta.group.capturing.regexp",
    );
    await expectUnsharedScopes();
  });

  it("discards provisional shared markers after a callback error", async () => {
    await start(source(5));
    const count = memberLayer().getMarkerCount();
    const prepared = spyOn(
      mode.rootLanguageLayer,
      "_prepareCombinedInjectionMember",
    ).and.callThrough();
    let calls = 0;
    spyOn(point, "content").and.callFake((node) => {
      if (++calls === 3) throw new Error("broken shared content");
      return node;
    });
    await expectAsync(
      mode.rootLanguageLayer._populateInjections(buffer.getRange(), null),
    ).toBeRejectedWithError("broken shared content");
    expect(memberLayer().getMarkerCount()).toBe(count);
    for (const call of prepared.calls.all()) {
      expect(call.returnValue.contentMarkers[0]).toBe(call.returnValue.marker);
      expect(call.returnValue.marker.isDestroyed()).toBe(true);
    }
  });

  it("discards shared markers from a superseded parent plan", async () => {
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
    buffer = new TextBuffer({ text: source(25) });
    mode = new TreeSitterLanguageMode({
      buffer,
      grammar: javascript,
      config: lumine.config,
      grammars: lumine.grammars,
      injectionReconcileChunkSize: 2,
    });
    buffer.setLanguageMode(mode);
    while (!resume) await new Promise((resolve) => setTimeout(resolve, 0));
    buffer.setText(source(3));
    resume();
    await mode.ready;
    await mode.atTransactionEnd();
    expect(memberLayer().getMarkerCount()).toBe(3);
    expect(members().length).toBe(3);
    expect(members().every((member) => member.contentMarkers[0] === member.marker)).toBe(true);
    await expectUnsharedScopes();
  });
});
