// LUMINE_SCROLL_CONFIG: {out, file, server, packages, cycles?, operation?, retiredTree?}.
// retiredTree queues one independent raw WASM tree after typing; no GC is forced.
// Optional profile handshakes are diagnostic only. Input files are never saved.
// requireSymbols waits for the full document cache before measuring edits.
const fs = require("fs"),
  path = require("path"),
  crypto = require("crypto");
describe("Typing then scrolling with language services", () => {
  it("captures delayed work", async () => {
    jasmine.useRealClock();
    const c = JSON.parse(process.env.LUMINE_SCROLL_CONFIG),
      sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
      hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
    const workspace = lumine.workspace.getElement();
    workspace.style.width = "1200px";
    workspace.style.height = "850px";
    jasmine.attachToDOM(workspace);
    lumine.config.set("ide-sofistik.serverPath", path.resolve(c.server));
    if (c.packages.includes("ide")) lumine.config.set("symbol.documentSource", "ide:ide-sofistik");
    for (const n of c.packages) await lumine.packages.activatePackage(n);
    lumine.config.set("symbol.providerTimeout", 10000);
    const result = { packages: c.packages, cases: [] },
      inputHash = hash(fs.readFileSync(c.file));
    for (let cycle = 0; cycle < (c.cycles || 2); cycle++) {
      const editor = await lumine.workspace.open(c.file);
      editor.getElement().setUpdatedSynchronously(false);
      await editor.whenGrammarSettled();
      editor.setCursorBufferPosition([
        cycle % 2 ? editor.getLastBufferRow() - 100 : Math.floor(editor.getLastBufferRow() / 2),
        0,
      ]);
      editor.scrollToCursorPosition({ mode: "center" });
      editor.getElement().focus();
      const services = [];
      const registry = lumine.packages.getActivePackage("symbol").mainModule.registry;
      const tokenManager = lumine.packages.getActivePackage("semantic-tokens").mainModule.manager;
      const originalAccept = tokenManager.acceptTokens;
      tokenManager.acceptTokens = function (state, tokens, ...args) {
        const at = performance.now(),
          previous = state.tokens;
        const record = (value) => {
          if (state.editor === editor)
            services.push({
              kind: "classification",
              at: performance.now(),
              ms: performance.now() - at,
              count: tokens.length,
              replaced: previous !== state.tokens,
            });
          return value;
        };
        const value = originalAccept.call(this, state, tokens, ...args);
        return value?.then ? value.then(record) : record(value);
      };
      const originalFetch = registry.runFileFetch;
      registry.runFileFetch = async function (target, ...args) {
        const at = performance.now();
        const result = await originalFetch.call(this, target, ...args);
        if (target === editor)
          services.push({
            kind: "symbol-fetch",
            at: performance.now(),
            ms: performance.now() - at,
            count: result?.flat.length ?? null,
          });
        return result;
      };
      let serviceSubscription, restoreRequest;
      let session;
      const ide = lumine.packages.getActivePackage("ide")?.mainModule;
      if (ide) {
        const at = performance.now();
        while (!(session = ide.manager.sessionForEditor(editor)) || session.state !== "running") {
          if (performance.now() - at > 60000) throw Error("LSP did not start");
          await sleep(50);
        }
        await session.openEditor(editor);
        serviceSubscription = ide.manager.onDidPublishDiagnostics((e) => {
          services.push({
            at: performance.now(),
            kind: "diagnostics",
            count: e.diagnostics?.length || 0,
            version: e.version,
          });
          console.timeStamp("diagnostics-" + cycle);
        });
        const original = session.connection.request;
        restoreRequest = () => {
          session.connection.request = original;
        };
        session.connection.request = function (method, ...args) {
          const at = performance.now();
          services.push({ kind: "request-start", method, at });
          const pending = original.call(this, method, ...args);
          Promise.resolve(pending).then(
            (value) =>
              services.push({
                at: performance.now(),
                kind: method,
                duration: performance.now() - at,
                count:
                  value?.items?.length ??
                  value?.data?.length ??
                  (Array.isArray(value) ? value.length : undefined),
              }),
            () => {},
          );
          return pending;
        };
        await session.request("textDocument/diagnostic", {
          textDocument: { uri: ide.manager.uriForEditor(editor) },
          identifier: "sofistik",
        });
      }
      if (c.outline) {
        lumine.commands.dispatch(workspace, "outline-view:show");
        editor.getElement().focus();
      }
      let retiredTree;
      if (c.retiredTree) {
        const { Parser } = require("node:module").createRequire(
          path.join(process.env.LUMINE_RESOURCE_PATH, "package.json"),
        )("web-tree-sitter");
        const parser = new Parser();
        parser.setLanguage(editor.getGrammar().getLanguageSync());
        retiredTree = parser.parse(editor.getText());
        parser.delete();
      }
      await sleep(2500);
      let initialSymbolCount;
      if (c.requireSymbols) {
        const symbols = await registry.getFileSymbols(editor);
        initialSymbolCount = symbols.length;
        expect(initialSymbolCount).toBeGreaterThan(c.requireSymbols);
        // Exclude publication work from the typing window.
        await sleep(500);
      }
      if (cycle === 0 && c.profile) {
        fs.writeFileSync(path.join(c.out, "ready"), "");
        while (!fs.existsSync(path.join(c.out, "go"))) await sleep(20);
      }
      let scrollSettledAt;
      const scrollSubscription = editor.getElement().onDidEndScrollAnimation(() => {
        scrollSettledAt = performance.now();
      });
      const frames = [],
        inputs = [],
        wheels = [];
      let previous,
        running = true;
      const frame = (t) => {
        if (!running) return;
        if (previous !== undefined) frames.push({ at: t, duration: t - previous });
        previous = t;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      await new Promise((r) => requestAnimationFrame(r));
      console.timeStamp("typing-" + cycle);
      const start = performance.now();
      for (let i = 0; i < 60; i++) {
        await sleep(Math.max(0, start + i * 16.667 - performance.now()));
        const at = performance.now();
        if (c.operation === "enter") editor.insertNewline();
        else editor.insertText(i % 12 === 11 ? " " : "a");
        inputs.push({ at, duration: performance.now() - at });
      }
      const inputEnd = performance.now();
      const syntaxSettlement = c.measureSyntaxSettlement
        ? editor.whenGrammarSettled().then(() => performance.now() - inputEnd)
        : null;
      const early = setTimeout(() => {
        services.push({ kind: "consumer-request", at: performance.now() });
        void Promise.all([
          registry.getFileSymbolTree(editor),
          registry.getFileSymbols(editor),
        ]).catch((error) => {
          throw error;
        });
      }, 50);
      const retirement = {};
      if (retiredTree) {
        const { idleDisposals } = require(
          path.join(process.env.LUMINE_RESOURCE_PATH, "src/idle-disposal-queue"),
        );
        retirement.queuedAt = performance.now();
        idleDisposals.add(retiredTree, (tree) => {
          retirement.startedAt = performance.now();
          tree.delete();
          retirement.duration = performance.now() - retirement.startedAt;
        });
      }
      console.timeStamp("scroll-" + cycle);
      const top = editor.getElement().getScrollTop();
      for (let i = 0; i < 180; i++) {
        await sleep(Math.max(0, inputEnd + i * 16.667 - performance.now()));
        const at = performance.now();
        editor.getElement().dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: i < 90 ? 30 : -30,
            deltaMode: 0,
            bubbles: true,
            cancelable: true,
          }),
        );
        wheels.push({
          at,
          duration: performance.now() - at,
          delay: at - inputEnd - i * 16.667,
          top: editor.getElement().getScrollTop(),
        });
      }
      await sleep(6000);
      const end = performance.now();
      running = false;
      console.timeStamp("done-" + cycle);
      await editor.whenGrammarSettled();
      const mode = editor.getBuffer().getLanguageMode();
      expect(mode.tree.input === editor.getText()).toBeTrue();
      expect(mode.tree.revision).toBe(editor.getBuffer().getTextRevision());
      expect(mode.tree.rootNode.endIndex).toBe(editor.getText().length);
      expect(wheels.some((w) => w.top !== top)).toBeTrue();
      if (c.retiredTree) expect(retirement.duration).toBeGreaterThan(0);
      result.cases.push({
        cycle,
        initialSymbolCount,
        syntaxReadyAfterInputMs: syntaxSettlement ? await syntaxSettlement : undefined,
        retirement,
        inputHash,
        outputHash: hash(editor.getText()),
        // Serializing a 196k-row syntax tree here takes seconds and leaves a
        // huge temporary string for GC in the next reopen. Validate revision,
        // input and extent instead; full syntax equivalence belongs in tests.
        syntaxHash: hash(
          JSON.stringify({
            revision: mode.tree.revision,
            endIndex: mode.tree.rootNode.endIndex,
            hasError: mode.tree.rootNode.hasError,
          }),
        ),
        start,
        inputEnd,
        scrollEnd: Math.max(wheels.at(-1).at, scrollSettledAt ?? 0),
        end,
        inputs,
        wheels,
        frames,
        services,
        session: session ? { state: session.state, adapter: session.adapter.id } : null,
      });
      fs.writeFileSync(path.join(c.out, "result.json"), JSON.stringify(result, null, 2));
      clearTimeout(early);
      tokenManager.acceptTokens = originalAccept;
      registry.runFileFetch = originalFetch;
      serviceSubscription?.dispose();
      scrollSubscription.dispose();
      restoreRequest?.();
      editor.destroy();
      await sleep(400);
      expect(hash(fs.readFileSync(c.file))).toBe(inputHash);
    }
    result.finished = true;
    fs.writeFileSync(path.join(c.out, "result.json"), JSON.stringify(result, null, 2));
    if (c.profile) {
      fs.writeFileSync(path.join(c.out, "stop"), "");
      while (!fs.existsSync(path.join(c.out, "stopped"))) await sleep(20);
    }
  }, 300000);
});
