// Fresh renderer per condition. LUMINE_AUTOCOMPLETE_COLD_CONFIG:
// {out, file, packages, idleMs}. No source file is saved.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

describe("Cold completion with the active package fleet", () => {
  it("measures input, publication, frames and repeated opening", async () => {
    jasmine.useRealClock();
    const config = JSON.parse(process.env.LUMINE_AUTOCOMPLETE_COLD_CONFIG);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
    const stats = (values) => {
      const sorted = values.slice().sort((a, b) => a - b);
      return {
        median: sorted[Math.floor(sorted.length * 0.5)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        max: sorted.at(-1),
      };
    };
    const waitFor = async (predicate) => {
      const start = performance.now();
      while (!predicate()) {
        if (performance.now() - start > 10000) throw new Error("Completion did not settle");
        await sleep(5);
      }
    };
    const workspace = lumine.workspace.getElement();
    workspace.style.width = "1200px";
    workspace.style.height = "850px";
    jasmine.attachToDOM(workspace);
    for (const name of config.packages)
      if (name !== "autocomplete") await lumine.packages.activatePackage(name);
    const inputHash = hash(fs.readFileSync(config.file));
    const result = { packages: config.packages, idleMs: config.idleMs, inputHash, cases: [] };
    let manager;
    for (let cycle = 0; cycle < 3; cycle++) {
      const editor = await lumine.workspace.open(config.file);
      editor.getElement().setUpdatedSynchronously(false);
      await editor.whenGrammarSettled();
      const row =
        cycle === 1 ? editor.getLastBufferRow() - 100 : Math.floor(editor.getLastBufferRow() / 2);
      // The generated JS fixture starts every row with `export function`.
      expect(editor.lineTextForBufferRow(row).startsWith("export function")).toBeTrue();
      editor.setCursorBufferPosition([row, 2]);
      editor.scrollToCursorPosition({ mode: "center" });
      editor.getElement().focus();
      await sleep(300);
      if (cycle === 0) {
        if (lumine.packages.isPackageActive("autocomplete"))
          await lumine.packages.deactivatePackage("autocomplete");
        if (lumine.packages.getLoadedPackage("autocomplete"))
          await lumine.packages.unloadPackage("autocomplete");
      }
      const frames = [];
      let running = true,
        previous;
      const frame = (at) => {
        if (!running) return;
        if (previous !== undefined) frames.push({ at, duration: at - previous });
        previous = at;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const activationStart = performance.now();
      if (cycle === 0)
        manager = (await lumine.packages.activatePackage("autocomplete")).mainModule
          .autocompleteManager;
      const activationMs = performance.now() - activationStart;
      lumine.config.set("autocomplete.autoActivationDelay", 0);
      expect(manager.editor === editor).toBeTrue();
      if (config.idleMs && cycle === 0) await sleep(config.idleMs);
      let publishedAt, suggestionsHash;
      const subscription = manager.suggestionList.onDidChangeItems((items) => {
        if (publishedAt !== undefined || !items?.length) return;
        publishedAt = performance.now();
        suggestionsHash = hash(
          JSON.stringify(items.map((s) => [s.text, s.replacementPrefix, s.type])),
        );
      });
      const preparedBeforeInput = Boolean(manager.completionPreparation?.value);
      const cpuStart = process.cpuUsage();
      const start = performance.now();
      editor.insertText("p");
      const firstMs = performance.now() - start;
      await waitFor(() => {
        const popup = editor.getElement().querySelector("autocomplete-suggestion-list");
        return (
          publishedAt !== undefined &&
          popup?.querySelector("li") &&
          !popup.hasAttribute("data-render-pending") &&
          !popup.hasAttribute("data-initializing")
        );
      });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const visibleFrameMs = performance.now() - start;
      const initialFrames = stats(frames.filter((f) => f.at >= start).map((f) => f.duration));
      subscription.dispose();
      const events = [],
        burstStart = performance.now();
      for (let i = 0; i < 120; i++) {
        await sleep(Math.max(0, burstStart + i * 16.667 - performance.now()));
        const at = performance.now();
        editor.insertText(i % 12 === 11 ? " " : "a");
        events.push({ at, duration: performance.now() - at, delay: at - burstStart - i * 16.667 });
      }
      await editor.whenGrammarSettled();
      await editor.autoIndentAtTransactionEndPromise;
      await editor.whenGrammarSettled();
      const cpu = process.cpuUsage(cpuStart);
      running = false;
      const mode = editor.getBuffer().getLanguageMode();
      expect(mode.tree.input).toBe(editor.getText());
      result.cases.push({
        cycle,
        preparedBeforeInput,
        activationMs,
        firstMs,
        publicationMs: publishedAt - start,
        popupAfterPublicationMs: visibleFrameMs - (publishedAt - start),
        visibleFrameMs,
        suggestionsHash,
        initialFrames,
        activationFrames: stats(
          frames.filter((f) => f.at >= activationStart && f.at < start).map((f) => f.duration),
        ),
        warmCommand: stats(events.map((e) => e.duration)),
        warmFrame: stats(frames.filter((f) => f.at >= burstStart).map((f) => f.duration)),
        cpuMs: (cpu.user + cpu.system) / 1000,
        outputHash: hash(editor.getText()),
        syntaxHash: hash(mode.tree.rootNode.toString()),
        raw: { activationStart, start, publishedAt, burstStart, events, frames },
      });
      editor.destroy();
      await sleep(200);
      expect(hash(fs.readFileSync(config.file))).toBe(inputHash);
      fs.writeFileSync(path.join(config.out, "result.json"), JSON.stringify(result, null, 2));
    }
    result.activePackages = config.packages.filter((name) => lumine.packages.isPackageActive(name));
    expect(result.activePackages.length).toBe(config.packages.length);
    result.finished = true;
    fs.writeFileSync(path.join(config.out, "result.json"), JSON.stringify(result, null, 2));
  }, 180000);
});
