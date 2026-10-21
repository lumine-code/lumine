const Client = require("../src/syntax-worker-client");
const { environment } = require("../src/syntax-worker-environment");
const Service = require("../src/syntax-worker-service");
const TextBuffer = require("../src/text-buffer");
const path = require("node:path");
const WorkerMode = require("../src/tree-sitter-worker-language-mode");

describe("Syntax worker transport", () => {
  it("colors mounted lines while a newer scroll destination is still waiting", async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-javascript");
    const service = new Service(lumine.grammars);
    const editor = lumine.workspace.buildTextEditor({ autoHeight: false });
    editor.setText("const value = 1; // color\n".repeat(3000));
    lumine.grammars.assignGrammar(
      editor.getBuffer(),
      lumine.grammars.grammarForScopeName("source.js"),
    );
    const mode = new WorkerMode({
      buffer: editor.getBuffer(),
      grammar: lumine.grammars.grammarForScopeName("source.js"),
      service,
    });
    editor.getBuffer().setLanguageMode(mode);
    const element = editor.getElement();
    element.style.cssText = "height:200px;width:800px";
    try {
      await mode.ready;
      await mode.refresh();
      // Hold further worker work so the old viewport and the new destination
      // can receive their colors independently, in a deterministic order.
      spyOn(mode, "schedule");
      jasmine.attachToDOM(element);
      element.setUpdatedSynchronously(true);
      const component = element.component;
      expect(editor.getBuffer().getLanguageMode()).toBe(mode);
      expect(component.visible).toBeTrue();
      component.updateSync();
      const prepared = mode.cache.snapshots.filter((item) => item.start.row < 128);
      mode.cache.clear();
      mode.emitter.emit("did-change-highlighting", new TextBuffer.Range([0, 0], [127, 0]));
      component.updateSync();
      expect(element.querySelectorAll(".syntax--keyword").length).toBe(0);
      const mounted = component.mountedTileStartRow;
      const transform = component.refs.lineTiles.style.transform;
      spyOn(component.window, "requestAnimationFrame").and.returnValue(1234567);
      component.setScrollTop(1000 * component.getLineHeight());
      component.beginScrollHighlighting();
      component.updateSync();
      expect(component.scrollHighlightingFrame).toBeTruthy();
      mode.cache.replace(prepared, { revision: 0, generation: 0 });
      const repaint = spyOn(component, "refreshMountedHighlighting");
      mode.emitter.emit("did-change-highlighting", new TextBuffer.Range([0, 0], [127, 0]));
      expect(element.querySelectorAll(".syntax--keyword").length).toBe(0);
      repaint.and.callThrough();
      mode.emitter.emit("did-change-highlighting", new TextBuffer.Range([0, 0], [127, 0]));
      expect(component.scrollHighlightingFrame).toBeTruthy();
      expect(component.mountedTileStartRow).toBe(mounted);
      expect(component.refs.lineTiles.style.transform).toBe(transform);
      expect(element.querySelectorAll(".syntax--keyword").length).toBeGreaterThan(0);
    } finally {
      editor.destroy();
      element.remove();
      service.dispose();
    }
  });

  it("keeps measurements behind the viewport and bounds background preparation", () => {
    const HighlightCache = require("../src/tree-sitter-highlight-cache");
    const buffer = new TextBuffer({ text: "x\n".repeat(10000) });
    const owner = {},
      measurement = {};
    const mode = {
      buffer,
      cache: new HighlightCache({ maxSnapshots: 256, maxEvents: 128000 }),
      folds: new Map(),
      wantedRanges: WorkerMode.prototype.wantedRanges,
      requests: new Set(),
      requestsByOwner: new WeakMap(),
      defaultOwner: {},
    };
    const request = (...args) => WorkerMode.prototype.requestHighlighting.call(mode, ...args);
    const stamp = { revision: 0, generation: 0, presentation: 0 };
    try {
      request(measurement, [[9000, 9000]], false, { priority: 2, prefetch: false });
      request(owner, [[1024, 1080]], false, { priority: 0, background: true });
      const wanted = WorkerMode.prototype.wantedRanges.call(mode);
      expect(wanted[0]).toEqual([1024, 1080]);
      expect(wanted.filter(([start]) => start >= 9000)).toEqual([[9000, 9000]]);
      const split = {};
      request(split, [[5000, 5100]], false, { priority: 0 });
      expect(WorkerMode.prototype.wantedRanges.call(mode).slice(0, 2)).toEqual([
        [1024, 1080],
        [5000, 5100],
      ]);
      request(split, [], false);
      mode.cache.replace(
        [
          {
            start: TextBuffer.Point(1024, 0),
            end: TextBuffer.Point(1280, 0),
            scopes: [],
            events: [],
          },
        ],
        stamp,
      );
      expect(WorkerMode.prototype.backgroundRange.call(mode, stamp)).toEqual([896, 1023]);
      mode.cache.snapshots[0].events = new Array(96000);
      expect(WorkerMode.prototype.backgroundRange.call(mode, stamp)).toBeUndefined();
      mode.cache.clear();
      mode.cache.replace(
        [
          {
            start: TextBuffer.Point(8000, 0),
            end: TextBuffer.Point(8128, 0),
            scopes: [],
            events: new Array(96000),
          },
        ],
        stamp,
      );
      mode.folds.set(8000, new TextBuffer.Range([8000, 1], [8001, 1]));
      expect(WorkerMode.prototype.backgroundRange.call(mode, stamp)).toEqual([1024, 1151]);
      expect(mode.cache.snapshots.length).toBe(0);
      expect(mode.folds.size).toBe(0);
      request(owner, [], false);
      expect(WorkerMode.prototype.backgroundRange.call(mode, stamp)).toBeUndefined();
    } finally {
      buffer.destroy();
    }
  });

  it("waits at most one frame for scroll colors and does not extend it for more input", () => {
    const Component = require("../src/text-editor-component");
    let ready = false,
      callback;
    const frameWindow = {
      requestAnimationFrame: jasmine.createSpy("requestAnimationFrame").and.callFake((fn) => {
        callback = fn;
        return 7;
      }),
      cancelAnimationFrame: jasmine.createSpy("cancelAnimationFrame"),
    };
    const component = {
      props: {
        model: {
          getBuffer: () => ({ getLanguageMode: () => ({ asynchronousSyntax: true }) }),
          displayLayer: { prepareHighlightingForScreenRows: () => ready },
        },
      },
      attached: true,
      visible: true,
      hasInitialMeasurements: true,
      scrollTopPending: true,
      scrollHighlightingRequested: true,
      window: frameWindow,
      getRenderedStartRow: () => 100,
      getRenderedEndRow: () => 140,
      cancelScrollHighlighting: Component.prototype.cancelScrollHighlighting,
      updateSync: jasmine.createSpy("updateSync"),
    };
    const wait = () => Component.prototype.waitForScrollHighlighting.call(component);
    expect(wait()).toBeTrue();
    expect(wait()).toBeTrue();
    expect(frameWindow.requestAnimationFrame).toHaveBeenCalledTimes(1);
    callback();
    expect(component.updateSync).toHaveBeenCalledTimes(1);
    expect(wait()).toBeFalse();
    expect(component.scrollHighlightingRequested).toBeFalse();

    component.scrollHighlightingRequested = true;
    expect(wait()).toBeTrue();
    ready = true;
    expect(wait()).toBeFalse();
    expect(frameWindow.cancelAnimationFrame).toHaveBeenCalledWith(7);
    expect(component.scrollHighlightingFrame).toBeNull();
    ready = false;
    component.scrollHighlightingRequested = true;
    component.resolveNextUpdatePromise = jasmine.createSpy("resolveNextUpdatePromise");
    expect(wait()).toBeTrue();
    component.cancelScrollHighlighting(true);
    expect(component.resolveNextUpdatePromise).toHaveBeenCalledTimes(1);
  });

  it("keeps the scroll deadline through geometry changes but cancels it on an edit", () => {
    const Component = require("../src/text-editor-component");
    let revision = 1;
    const mode = {};
    const buffer = { getTextRevision: () => revision, getLanguageMode: () => mode };
    const frame = {
      window: { cancelAnimationFrame: jasmine.createSpy("cancelAnimationFrame") },
      handle: 1,
    };
    const component = {
      props: { model: { getBuffer: () => buffer } },
      scrollHighlightingFrame: frame,
      cancelScrollHighlighting: Component.prototype.cancelScrollHighlighting,
      spliceLineTopIndex: jasmine.createSpy("spliceLineTopIndex"),
      scheduleUpdate: jasmine.createSpy("scheduleUpdate"),
      hasInitialMeasurements: false,
      scrollTop: 0,
    };
    Component.prototype.beginScrollHighlighting.call(component);
    const changes = [
      {
        oldRange: new TextBuffer.Range([0, 0], [1, 0]),
        newRange: new TextBuffer.Range([0, 0], [1, 0]),
      },
    ];
    Component.prototype.didChangeDisplayLayer.call(component, changes);
    expect(component.scrollHighlightingFrame).toBe(frame);
    expect(component.scrollHighlightingRequested).toBeTrue();
    revision++;
    Component.prototype.didChangeDisplayLayer.call(component, changes);
    expect(component.scrollHighlightingFrame).toBeNull();
    expect(component.scrollHighlightingRequested).toBeFalse();
  });

  it("prepares native thumb positions before their frame without dropping subsequent input", () => {
    const Component = require("../src/text-editor-component");
    const calls = [];
    const displayLayer = {
      prepareHighlightingForScreenRows: (...args) => calls.push(["prepare", ...args]),
    };
    const component = {
      props: {
        model: {
          displayLayer,
          getBuffer: () => ({
            getLanguageMode: () => ({ asynchronousSyntax: true }),
            getTextRevision: () => 1,
          }),
        },
      },
      scrollTopPending: true,
      beginScrollHighlighting: Component.prototype.beginScrollHighlighting,
      setScrollTop(position) {
        this.position = position;
        return true;
      },
      getRenderedStartRow() {
        return this.position;
      },
      getRenderedEndRow() {
        return this.position + 40;
      },
      scheduleUpdate: () => calls.push(["schedule"]),
      updateSync: jasmine.createSpy("updateSync"),
    };
    for (const position of [100, 200, 300])
      Component.prototype.didScrollDummyScrollbar.call(component, {
        orientation: "vertical",
        position,
      });
    expect(component.position).toBe(300);
    expect(calls).toEqual([
      ["prepare", 100, 140, displayLayer],
      ["schedule"],
      ["prepare", 200, 240, displayLayer],
      ["schedule"],
      ["prepare", 300, 340, displayLayer],
      ["schedule"],
    ]);
    expect(component.updateSync).not.toHaveBeenCalled();
  });

  it("keeps the current viewport ahead of prefetch during rapid thumb movement", () => {
    const owner = {};
    const mode = {
      buffer: { getLastRow: () => 100000, clipPosition: TextBuffer.Point.fromObject },
      cache: { covers: () => false },
      requests: new Set(),
      requestsByOwner: new WeakMap(),
      defaultOwner: {},
    };
    const request = (range) =>
      WorkerMode.prototype.requestHighlighting.call(mode, owner, [range], false);
    request([100, 140]);
    request([500, 540]);
    expect(WorkerMode.prototype.wantedRanges.call(mode)[0]).toEqual([500, 540]);
    request([900, 940]);
    const wanted = WorkerMode.prototype.wantedRanges.call(mode);
    expect(wanted[0]).toEqual([900, 940]);
    expect(wanted.every(([first, last]) => last - first < 128)).toBeTrue();
    request([500, 540]);
    expect(WorkerMode.prototype.wantedRanges.call(mode)[0]).toEqual([500, 540]);
  });

  it("prepares every folded viewport fragment before prefetch without querying hidden rows", () => {
    const owner = {};
    const mode = {
      buffer: { getLastRow: () => 20000, clipPosition: TextBuffer.Point.fromObject },
      cache: { covers: () => false },
      requests: new Set(),
      requestsByOwner: new WeakMap(),
      defaultOwner: {},
    };
    WorkerMode.prototype.requestHighlighting.call(
      mode,
      owner,
      [
        [10, 10],
        [10000, 10000],
      ],
      false,
    );
    const ranges = WorkerMode.prototype.wantedRanges.call(mode);
    expect(ranges.slice(0, 2)).toEqual([
      [10, 10],
      [10000, 10000],
    ]);
    expect(ranges.every(([first, last]) => last <= 10 || first >= 10000)).toBeTrue();
  });

  it("makes parsed syntax available while viewport paint is still waiting", async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-javascript");
    const service = new Service(lumine.grammars);
    const editor = lumine.workspace.buildTextEditor();
    editor.setText("const ready = 1;\n");
    let release;
    const paint = new Promise((resolve) => {
      release = resolve;
    });
    const request = service.request.bind(service);
    spyOn(service, "request").and.callFake((session, operation, data, options) =>
      operation === "view"
        ? paint.then(() => request(session, operation, data, options))
        : request(session, operation, data, options),
    );
    const mode = new WorkerMode({
      buffer: editor.getBuffer(),
      grammar: lumine.grammars.grammarForScopeName("source.js"),
      service,
    });
    editor.getBuffer().setLanguageMode(mode);
    try {
      await mode.ready;
      expect(mode.tokenized).toBeTrue();
      expect(mode.cache.snapshots.length).toBe(0);
      const result = await editor.analyzeSyntax(
        path.join(__dirname, "fixtures/syntax-worker-analysis.js"),
        "summary",
      );
      expect(result.text).toBe(editor.getText());
      release();
      await mode.refresh();
      expect(mode.cache.snapshots.length).toBeGreaterThan(0);
    } finally {
      release();
      editor.destroy();
      service.dispose();
    }
  });

  it("invalidates prefetched colors without relaying them as offscreen geometry edits", () => {
    const Component = require("../src/text-editor-component");
    const editor = lumine.workspace.buildTextEditor();
    editor.setText("line\n".repeat(500));
    const changes = [];
    const subscription = editor.displayLayer.onDidChange((value) => changes.push(...value));
    const component = {
      props: { model: editor },
      mountedTileStartRow: 100,
      mountedTileEndRow: 150,
      scheduleUpdate: jasmine.createSpy("scheduleUpdate"),
      spliceLineTopIndex: jasmine.createSpy("spliceLineTopIndex"),
      settlingScrollAnchor: {},
    };
    const merge = spyOn(editor, "mergeIntersectingSelections").and.callThrough();
    try {
      editor
        .getBuffer()
        .getLanguageMode()
        .emitter.emit("did-change-highlighting", new TextBuffer.Range([300, 0], [320, 0]));
      expect(changes.length).toBeGreaterThan(0);
      expect(changes.every((change) => change.origin === "highlight")).toBeTrue();
      expect(merge).not.toHaveBeenCalled();
      Component.prototype.didChangeDisplayLayer.call(component, changes);
      Component.prototype.didChangeDisplayLayer.call(component, [
        { origin: "highlight", newRange: new TextBuffer.Range([90, 0], [100, 0]) },
      ]);
      expect(component.scheduleUpdate).not.toHaveBeenCalled();
      expect(component.spliceLineTopIndex).not.toHaveBeenCalled();
      Component.prototype.didChangeDisplayLayer.call(component, [
        { origin: "highlight", newRange: new TextBuffer.Range([110, 0], [120, 0]) },
      ]);
      expect(component.scheduleUpdate).toHaveBeenCalledTimes(1);
      expect(component.settlingScrollAnchor).toBeTruthy();
    } finally {
      subscription.dispose();
      editor.destroy();
    }
  });

  it("publishes a complete viewport across cache tiles and retargets its stream while scrolling", async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-javascript");
    const service = new Service(lumine.grammars);
    const editor = lumine.workspace.buildTextEditor();
    editor.setText("const value = 1; // color\n".repeat(3000));
    const mode = new WorkerMode({
      buffer: editor.getBuffer(),
      grammar: lumine.grammars.grammarForScopeName("source.js"),
      service,
    });
    editor.getBuffer().setLanguageMode(mode);
    const owner = {};
    let published = false,
      retargeted = false;
    const subscription = mode.onDidChangeHighlighting((range) => {
      if (range.start.row === 500) published = true;
    });
    try {
      await mode.ready;
      await mode.refresh();
      const request = service.request.bind(service);
      spyOn(service, "request").and.callFake((session, operation, data, options) => {
        if (operation !== "view") return request(session, operation, data, options);
        const accept = options.onChunk;
        return request(session, operation, data, {
          ...options,
          onChunk(packet) {
            if (packet.kind !== "end" || retargeted) return accept(packet);
            mode.requestHighlighting(owner, [[2048, 2070]]);
            const answer = accept(packet);
            expect(published).toBeTrue();
            expect(
              mode.cache.covers(TextBuffer.Point(500, 0), TextBuffer.Point(541, 0)),
            ).toBeTrue();
            expect(answer.range).toEqual([2048, 2070]);
            retargeted = true;
            return answer;
          },
        });
      });
      mode.requestHighlighting(owner, [[500, 540]]);
      await mode.refresh();
      expect(retargeted).toBeTrue();
      expect(mode.error).toBeFalsy();
      expect(mode.cache.covers(TextBuffer.Point(2048, 0), TextBuffer.Point(2071, 0))).toBeTrue();
      const before = service.request.calls.count();
      mode.requestHighlighting(owner, [[2048, 2070]]);
      await mode.refresh();
      expect(service.request.calls.count()).toBe(before);
    } finally {
      subscription.dispose();
      editor.destroy();
      service.dispose();
    }
  });

  it("recovers a failed grammar generation after its definition is repaired", async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-javascript");
    const service = new Service(lumine.grammars);
    const editor = lumine.workspace.buildTextEditor();
    editor.setText("const value = 1;\n");
    const grammar = lumine.grammars.grammarForScopeName("source.js");
    const wasm = grammar.definition.treeSitter.grammar;
    const mode = new WorkerMode({ buffer: editor.getBuffer(), grammar, service });
    editor.getBuffer().setLanguageMode(mode);
    spyOn(console, "error");
    try {
      await mode.ready;
      grammar.definition.treeSitter.grammar = "missing-syntax-worker-test.wasm";
      service.invalidateEnvironment();
      await conditionPromise(() => mode.error);
      expect(console.error).toHaveBeenCalled();
      grammar.definition.treeSitter.grammar = wasm;
      service.invalidateEnvironment();
      await service.ensureEnvironment();
      await service.settle(mode.session);
      await mode.ready;
      await mode.refresh();
      expect(mode.error).toBeFalsy();
      expect(mode.tokenized).toBeTrue();
      const result = await editor.analyzeSyntax(
        path.join(__dirname, "fixtures/syntax-worker-analysis.js"),
        "summary",
      );
      expect(result.text).toBe(editor.getText());
    } finally {
      grammar.definition.treeSitter.grammar = wasm;
      editor.destroy();
      service.dispose();
    }
  });

  it("runs portable root range policies beside the parser across edits and policy replacement", async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-javascript");
    const service = new Service(lumine.grammars);
    const editor = lumine.workspace.buildTextEditor();
    const module = path.join(__dirname, "fixtures/syntax-worker-analysis.js");
    const buffer = editor.getBuffer();
    editor.setText("const hidden = 0;\nconst visible = 1;\n");
    const original = lumine.grammars.setRootLanguageRanges(buffer, {
      module,
      method: "rootRanges",
      params: { prefix: "const visible" },
    });
    const mode = new WorkerMode({
      buffer,
      grammar: lumine.grammars.grammarForScopeName("source.js"),
      service,
    });
    buffer.setLanguageMode(mode);
    let replacement;
    try {
      await mode.ready;
      expect(await editor.analyzeSyntax(module, "rootChildren")).toEqual(["const visible = 1;"]);
      buffer.insert([0, 0], "// shifted\n");
      expect(await editor.analyzeSyntax(module, "rootChildren")).toEqual(["const visible = 1;"]);
      const obsolete = editor.analyzeSyntax(module, "rootChildren");
      replacement = lumine.grammars.setRootLanguageRanges(buffer, {
        module,
        method: "rootRanges",
        params: { prefix: "const hidden" },
      });
      original.dispose();
      expect(await obsolete).toBeNull();
      expect(await editor.analyzeSyntax(module, "rootChildren")).toEqual(["const hidden = 0;"]);
      replacement.dispose();
      expect(await editor.analyzeSyntax(module, "rootChildren")).toEqual([
        "// shifted",
        "const hidden = 0;",
        "const visible = 1;",
      ]);
      expect(await editor.isBufferRowCommented(0)).toBeTrue();
      expect(await editor.isBufferRowCommented(1)).toBeFalse();
      expect(() => lumine.grammars.setRootLanguageRanges(buffer, () => [])).toThrowError(
        /descriptor/,
      );
      expect(mode.error).toBeFalsy();
    } finally {
      original.dispose();
      replacement?.dispose();
      editor.destroy();
      service.dispose();
    }
  });

  it("mirrors large insertions and independent edit batches in bounded packets", async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-javascript");
    const service = new Service(lumine.grammars);
    const buffer = new TextBuffer({
      text: Array.from({ length: 512 }, (_, row) => `const value${row} = ${row};`).join("\n"),
    });
    const session = service.acquire(
      buffer,
      lumine.grammars.grammarForScopeName("source.js"),
      () => {},
    );
    try {
      await service.settle(session);
      const sent = spyOn(service.client, "request").and.callThrough();
      buffer.setTextInIndependentRanges(
        Array.from({ length: 512 }, (_, row) => ({
          range: [
            [row, 6],
            [row, 6],
          ],
          text: "new_",
        })),
      );
      buffer.append("\n/*" + "x".repeat(180000) + "*/\n");
      await service.settle(session);
      const result = await service.request(session, "analyze", {
        module: path.join(__dirname, "fixtures/syntax-worker-analysis.js"),
        method: "summary",
      });
      expect(result.text).toBe(buffer.getText());
      const calls = sent.calls.allArgs();
      expect(calls.filter(([operation]) => operation === "edit-begin").length).toBe(2);
      expect(calls.filter(([operation]) => operation === "edit-commit").length).toBe(2);
      expect(calls.some(([operation]) => operation === "edit-text-chunk")).toBeTrue();
      for (const [operation, data] of calls) {
        if (operation === "edit-chunk") {
          expect(data.changes.length).toBeLessThanOrEqual(128);
          expect(
            data.changes.reduce((sum, change) => sum + change.text.length, 0),
          ).toBeLessThanOrEqual(65536);
        }
        if (operation === "edit-text-chunk") expect(data.text.length).toBeLessThanOrEqual(65536);
      }
    } finally {
      service.release(session);
      buffer.destroy();
      service.dispose();
    }
  });
  it("reuses viewport tiles and publishes only affected rows after a local edit", async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-javascript");
    const service = new Service(lumine.grammars);
    const editor = lumine.workspace.buildTextEditor();
    editor.setText(
      Array.from({ length: 400 }, (_, i) => `const value${i} = ${i}; // comment`).join("\n"),
    );
    const mode = new WorkerMode({
      buffer: editor.getBuffer(),
      grammar: lumine.grammars.grammarForScopeName("source.js"),
      service,
    });
    editor.getBuffer().setLanguageMode(mode);
    try {
      await mode.ready;
      const requests = spyOn(service, "request").and.callThrough();
      mode.requestHighlighting(editor, [[160, 180]]);
      await mode.refresh();
      const views = () => requests.calls.allArgs().filter((args) => args[1] === "view").length;
      const before = views();
      mode.requestHighlighting(editor, [[161, 181]]);
      await mode.refresh();
      expect(views()).toBe(before);
      const updates = [];
      const subscription = mode.onDidChangeHighlighting((range) => updates.push(range));
      editor.getBuffer().insert([170, 8], "x");
      expect(mode.publicationPending).toBeTrue();
      const cached = editor.scopeDescriptorForBufferPosition([
        170,
        editor.lineTextForBufferRow(170).length - 1,
      ]);
      expect(cached.getScopesArray().some((scope) => scope.startsWith("comment"))).toBeTrue();
      await editor.whenGrammarSettled();
      await mode.refresh();
      expect(mode.error).toBeFalsy();
      expect(updates.length).toBeGreaterThan(0);
      expect(updates.every((range) => range.start.row >= 169 && range.end.row <= 172)).toBeTrue();
      subscription.dispose();
    } finally {
      editor.destroy();
      service.dispose();
    }
  });
  it("restores visible foldability after an offscreen edit leaves its colors unchanged", async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-javascript");
    const service = new Service(lumine.grammars);
    const editor = lumine.workspace.buildTextEditor();
    editor.setText("function work() {\n" + "  const value = 1;\n".repeat(1000) + "}\n");
    const mode = new WorkerMode({
      buffer: editor.getBuffer(),
      grammar: lumine.grammars.grammarForScopeName("source.js"),
      service,
    });
    editor.getBuffer().setLanguageMode(mode);
    let subscription;
    try {
      await mode.ready;
      mode.requestHighlighting(editor, [[0, 10]]);
      await mode.refresh();
      expect(mode.isFoldableAtRowForRendering(0)).toBeTrue();
      const updates = [];
      subscription = mode.onDidChangeHighlighting((range) => updates.push(range));
      editor.getBuffer().insert([900, 0], " ");
      expect(mode.isFoldableAtRowForRendering(0)).toBeFalse();
      await editor.whenGrammarSettled();
      await mode.refresh();
      expect(mode.isFoldableAtRowForRendering(0)).toBeTrue();
      expect(updates.some((range) => range.start.row === 0)).toBeTrue();
    } finally {
      subscription?.dispose();
      editor.destroy();
      service.dispose();
    }
  });
  it("retains every newline indentation intent in a rapid multi-line typing burst", async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-javascript");
    const service = new Service(lumine.grammars);
    const editor = lumine.workspace.buildTextEditor();
    editor.setText("if (ok) {\n}");
    const mode = new WorkerMode({
      buffer: editor.getBuffer(),
      grammar: lumine.grammars.grammarForScopeName("source.js"),
      service,
    });
    editor.getBuffer().setLanguageMode(mode);
    try {
      await mode.ready;
      editor.update({ autoIndent: true, tabLength: 2, softTabs: true });
      editor.setCursorBufferPosition([0, 9]);
      for (let index = 0; index < 4; index++) {
        editor.insertNewline();
        editor.insertText("work();");
      }
      await editor.whenGrammarSettled();
      expect(editor.getText()).toBe("if (ok) {\n" + "  work();\n".repeat(4) + "}");
    } finally {
      editor.destroy();
      service.dispose();
    }
  });

  for (const multiple of [false, true])
    it(`keeps indentation when typing immediately after Enter (${multiple ? "multiple cursors" : "one cursor"})`, async () => {
      jasmine.useRealClock();
      await lumine.packages.activatePackage("language-javascript");
      const service = new Service(lumine.grammars);
      const editor = lumine.workspace.buildTextEditor({
        tabLength: 2,
        softTabs: true,
        autoIndent: true,
      });
      editor.setText(multiple ? "if (one) {\n}\nif (two) {\n}" : "if (one) {\n}");
      const mode = new WorkerMode({
        buffer: editor.getBuffer(),
        grammar: lumine.grammars.grammarForScopeName("source.js"),
        service,
      });
      editor.getBuffer().setLanguageMode(mode);
      try {
        await mode.ready;
        editor.update({ autoIndent: true, tabLength: 2, softTabs: true });
        expect(editor.shouldAutoIndent()).toBeTrue();
        editor.setSelectedBufferRanges(
          multiple
            ? [
                [
                  [0, 10],
                  [0, 10],
                ],
                [
                  [2, 10],
                  [2, 10],
                ],
              ]
            : [
                [
                  [0, 10],
                  [0, 10],
                ],
              ],
        );
        editor.insertNewline();
        editor.insertText("value()");
        await editor.whenGrammarSettled();
        expect(editor.getText()).toBe(
          multiple
            ? "if (one) {\n  value()\n}\nif (two) {\n  value()\n}"
            : "if (one) {\n  value()\n}",
        );
      } finally {
        editor.destroy();
        service.dispose();
      }
    });
  it("recreates the syntax owner from current text after a crash without retrying forever", async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-javascript");
    const service = new Service(lumine.grammars);
    const buffer = new TextBuffer({ text: "const value = 1;\n" });
    const events = [];
    const session = service.acquire(
      buffer,
      lumine.grammars.grammarForScopeName("source.js"),
      (event) => events.push(event.event),
    );
    try {
      await service.settle(session);
      buffer.insert([0, 6], "edited_");
      const first = service.client;
      first.close(new Error("simulated worker crash"));
      buffer.append("// during restart\n");
      await service.settle(session);
      expect(service.client).not.toBe(first);
      const result = await service.request(session, "analyze", {
        module: path.join(__dirname, "fixtures/syntax-worker-analysis.js"),
        method: "summary",
      });
      expect(result.text).toBe(buffer.getText());
      expect(events).toContain("recovering");
      expect(events).toContain("recovered");
      service.client.close(new Error("repeated worker crash"));
      await expectAsync(service.settle(session)).toBeRejectedWithError("repeated worker crash");
      expect(service.client).toBeNull();
    } finally {
      service.release(session);
      buffer.destroy();
      service.dispose();
    }
  });
  it("plans editor indentation, comments, folds and syntax selections in the parser owner", async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-javascript");
    const service = new Service(lumine.grammars);
    const editor = lumine.workspace.buildTextEditor({ tabLength: 2, softTabs: true });
    editor.setText("function example() {\nreturn 3;\n}\n");
    const mode = new WorkerMode({
      buffer: editor.getBuffer(),
      grammar: lumine.grammars.grammarForScopeName("source.js"),
      service,
    });
    editor.getBuffer().setLanguageMode(mode);
    try {
      await mode.ready;
      await editor.autoIndentBufferRows(0, 2);
      expect(editor.lineTextForBufferRow(1)).toBe("  return 3;");
      await editor.whenGrammarSettled();
      await editor.foldAll();
      expect(editor.isFoldedAtBufferRow(0)).toBeTrue();
      editor.unfoldAll();
      editor.setCursorBufferPosition([1, 9]);
      await editor.selectLargerSyntaxNode();
      expect(editor.getSelectedText()).toBe("3");
      editor.setSelectedBufferRanges([
        [
          [0, 0],
          [0, 0],
        ],
        [
          [1, 2],
          [1, 2],
        ],
      ]);
      await editor.toggleLineCommentsInSelection();
      expect(editor.lineTextForBufferRow(0)).toMatch(/^\/\//);
      expect(editor.lineTextForBufferRow(1)).toMatch(/^\s*\/\//);
      await editor.toggleLineCommentsInSelection();
      expect(editor.lineTextForBufferRow(0)).toBe("function example() {");
      expect(editor.lineTextForBufferRow(1)).toBe("  return 3;");
      const result = await editor.analyzeSyntax(
        path.join(__dirname, "fixtures/syntax-worker-analysis.js"),
        "summary",
      );
      expect(result.text).toBe(editor.getText());
      expect(mode.rootLanguageLayer).toBeUndefined();
    } finally {
      editor.destroy();
      service.dispose();
    }
  });
  it("loads the core through its browser bootstrap and returns versioned scopes", async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-javascript");
    const client = new Client();
    try {
      await client.request("environment", environment(lumine.grammars, 1, { specMode: true }));
      const data = { session: 1, revision: 0, scopeName: "source.js", path: "example.js" };
      await client.request("open", data);
      await client.request("append", { session: 1, text: "function example() {\n return 3;\n}\n" });
      await client.request("initialize", data);
      const settled = await client.request("settle", data);
      expect(settled.revision).toBe(0);
      expect(settled.value.parseError).toBeNull();
      const view = await client.request("view", { ...data, ranges: [[0, 3]] });
      expect(view.value.tiles[0].events.length).toBeGreaterThan(2);
      expect(view.value.scopes.some(([, name]) => name === "source.js")).toBeTrue();
      await client.request("close", data);
    } finally {
      client.close();
    }
  });

  it("mirrors edits made during startup and closes a document without retaining its requests", async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-javascript");
    const service = new Service(lumine.grammars);
    const buffer = new TextBuffer({ text: "const value = 3;\n" });
    const session = service.acquire(
      buffer,
      lumine.grammars.grammarForScopeName("source.js"),
      () => {},
    );
    try {
      buffer.insert([0, 6], "new_");
      await service.settle(session);
      const result = await service.request(session, "analyze", {
        module: path.join(__dirname, "fixtures/syntax-worker-analysis.js"),
        method: "summary",
      });
      expect(result.text).toBe(buffer.getText());
      expect(service.client.pending.size).toBe(0);
      service.release(session);
      expect(service.sessions.size).toBe(0);
    } finally {
      buffer.destroy();
      service.dispose();
    }
  });
});
