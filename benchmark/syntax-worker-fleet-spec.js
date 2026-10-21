// Optional large-document benchmark. Source files are read and edited only in memory.
const fs = require("fs"),
  path = require("path"),
  crypto = require("crypto");
describe("Syntax worker fleet latency", () => {
  it("captures delayed work", async () => {
    jasmine.useRealClock();
    const c = JSON.parse(process.env.LUMINE_SYNTAX_BENCHMARK_CONFIG || "{}"),
      sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
      hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
    if (
      !c.file ||
      !c.out ||
      !["inline", "worker"].includes(c.backend) ||
      !Array.isArray(c.packages)
    )
      throw new Error("Set LUMINE_SYNTAX_BENCHMARK_CONFIG with file, out, backend and packages");
    for (const required of ["symbol", "symbol-tree-sitter", "semantic-tokens"])
      if (!c.packages.includes(required)) throw new Error(`Missing benchmark package: ${required}`);
    c.worker = c.backend === "worker";
    c.file = path.resolve(c.file);
    fs.mkdirSync(c.out, { recursive: true });
    const lifecycle = [];
    let lifecyclePhase = "setup",
      lastBeat = performance.now();
    const beat = setInterval(() => {
      const now = performance.now();
      lifecycle.push({ phase: lifecyclePhase, at: now, delay: now - lastBeat });
      lastBeat = now;
    }, 8);
    let rendererParses = 0;
    const Parser = require("../src/tree-sitter-parser");
    const begin = Parser.prototype.begin;
    Parser.prototype.begin = function (text, ...args) {
      if (text.length > 1000000) rendererParses++;
      return begin.call(this, text, ...args);
    };
    let activeEditor;
    try {
      const workspace = lumine.workspace.getElement();
      workspace.style.width = "1200px";
      workspace.style.height = "850px";
      jasmine.attachToDOM(workspace);
      if (c.server) lumine.config.set("ide-sofistik.serverPath", path.resolve(c.server));
      if (c.packages.includes("ide"))
        lumine.config.set("symbol.documentSource", "ide:ide-sofistik");
      lumine.grammars.syntaxExecution = c.worker ? "worker" : "inline";
      for (const n of c.packages) await lumine.packages.activatePackage(n);
      lumine.config.set("symbol.providerTimeout", 10000);
      const result = {
          backend: c.backend,
          packages: c.packages,
          runtime: { node: process.versions.node, electron: process.versions.electron },
          configuration: {
            inputCount: c.inputCount ?? 60,
            cycles: c.cycles || 2,
            idleMs: c.idleMs ?? 6000,
            operation: c.operation ?? "letters",
            inputIntervalMs: c.inputInterval ?? 16.667,
          },
          cases: [],
        },
        inputHash = hash(fs.readFileSync(c.file));
      for (let cycle = 0; cycle < (c.cycles || 2); cycle++) {
        lifecyclePhase = `open-${cycle}`;
        const editor = (activeEditor = await lumine.workspace.open(c.file));
        for (const method of ["save", "saveAs"])
          spyOn(editor.getBuffer(), method).and.callFake(() => {
            throw new Error("Benchmark fixtures must not be saved");
          });
        expect(Boolean(editor.getBuffer().getLanguageMode().asynchronousSyntax)).toBe(
          Boolean(c.worker),
        );
        result.input ??= {
          utf16Units: editor.getBuffer().getLength(),
          rows: editor.getLineCount(),
        };
        editor.getElement().setUpdatedSynchronously(false);
        await editor.whenGrammarSettled();
        editor.setCursorBufferPosition([
          cycle % 2
            ? Math.max(0, editor.getLastBufferRow() - 100)
            : Math.floor(editor.getLastBufferRow() / 2),
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
        await sleep(2500);
        let initialSymbolCount;
        if (c.requireSymbols) {
          const symbols = await registry.getFileSymbols(editor);
          initialSymbolCount = symbols.length;
          expect(initialSymbolCount).toBeGreaterThan(c.requireSymbols);
          // Exclude publication work from the typing window.
          await sleep(500);
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
          if (previous !== undefined)
            frames.push({ at: t, duration: t - previous, callbackLag: performance.now() - t });
          previous = t;
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
        await new Promise((r) => requestAnimationFrame(r));
        console.timeStamp("typing-" + cycle);
        lifecyclePhase = `typing-${cycle}`;
        const start = performance.now();
        for (let i = 0; i < (c.inputCount ?? 60); i++) {
          const scheduledAt = start + i * (c.inputInterval ?? 16.667);
          await sleep(Math.max(0, scheduledAt - performance.now()));
          const at = performance.now();
          if (c.operation === "enter") editor.insertNewline();
          else editor.insertText(i % 12 === 11 ? " " : "a");
          inputs.push({ at, duration: performance.now() - at, delay: at - scheduledAt });
        }
        lifecyclePhase = `after-edit-${cycle}`;
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
        await sleep(c.idleMs ?? 6000);
        const end = performance.now();
        running = false;
        console.timeStamp("done-" + cycle);
        lifecyclePhase = `validate-${cycle}`;
        await editor.whenGrammarSettled();
        const mode = editor.getBuffer().getLanguageMode();
        const syntax = await editor.analyzeSyntax(
          require.resolve("./syntax-worker-analysis"),
          "summary",
        );
        expect(mode.error).toBeFalsy();
        expect(syntax.inputHash).toBe(hash(editor.getText()));
        if (mode.asynchronousSyntax) await mode.refresh();
        expect(syntax.revision).toBe(editor.getBuffer().getTextRevision());
        expect(syntax.endIndex).toBe(editor.getText().length);
        expect(wheels.some((w) => w.top !== top)).toBeTrue();
        result.cases.push({
          cycle,
          owner: c.worker ? "worker" : "renderer",
          ownerError: mode.error?.stack,
          memory: process.memoryUsage(),
          initialSymbolCount,
          syntaxReadyAfterInputMs: syntaxSettlement ? await syntaxSettlement : undefined,
          inputHash,
          outputHash: hash(editor.getText()),
          // Serializing a 196k-row syntax tree here takes seconds and leaves a
          // huge temporary string for GC in the next reopen. Validate revision,
          // input and extent instead; full syntax equivalence belongs in tests.
          syntaxHash: hash(
            JSON.stringify({
              revision: syntax.revision,
              endIndex: syntax.endIndex,
              hasError: syntax.hasError,
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
        lifecyclePhase = `close-${cycle}`;
        editor.destroy();
        activeEditor = null;
        await sleep(400);
        expect(hash(fs.readFileSync(c.file))).toBe(inputHash);
      }
      lumine.grammars.syntaxWorkerService?.dispose();
      clearInterval(beat);
      result.lifecycle = lifecycle;
      result.largeRendererParses = rendererParses;
      if (c.worker) expect(rendererParses).toBe(0);
      result.finished = true;
      fs.writeFileSync(path.join(c.out, "result.json"), JSON.stringify(result, null, 2));
    } finally {
      clearInterval(beat);
      activeEditor?.destroy();
      Parser.prototype.begin = begin;
      lumine.grammars.syntaxWorkerService?.dispose();
      lumine.grammars.syntaxWorkerService = null;
    }
  }, 300000);
});
