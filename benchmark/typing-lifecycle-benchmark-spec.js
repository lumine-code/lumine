// Isolated test runner benchmark. LUMINE_TYPING_LIFECYCLE_CONFIG supplies
// { out, files, packages, cycles, count, interval, undo }. Files are never saved.
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
describe("Long typing and buffer lifecycle", () => {
  it("keeps private files unchanged while recording long tasks", async () => {
    jasmine.useRealClock();
    const config = JSON.parse(process.env.LUMINE_TYPING_LIFECYCLE_CONFIG),
      hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
    if (
      !config.files?.length ||
      !(config.cycles > 0) ||
      !(config.count > 0) ||
      !(config.interval > 0)
    )
      throw new Error("Expected files, cycles, count and interval");
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
      out = config.out;
    for (const name of config.packages) await lumine.packages.activatePackage(name);
    const workspace = lumine.workspace.getElement();
    workspace.style.width = "1200px";
    workspace.style.height = "850px";
    jasmine.attachToDOM(workspace);
    const result = {
      config: { ...config, files: undefined, out: undefined },
      cycles: [],
      longTasks: [],
      gc: [],
      clock: {
        browserOrigin: performance.timeOrigin,
        nodeOrigin: require("node:perf_hooks").performance.timeOrigin,
      },
    };
    const longObserver = new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        result.longTasks.push({ start: e.startTime, duration: e.duration, name: e.name });
    });
    longObserver.observe({ type: "longtask", buffered: true });
    const stamp = (name) => {
      console.timeStamp(name);
      return performance.now();
    };
    const hashes = config.files.map((file) => hash(fs.readFileSync(file)));
    const stats = (a) => {
      const s = a.slice().sort((a, b) => a - b);
      return {
        median: s[Math.floor(s.length * 0.5)],
        p95: s[Math.floor(s.length * 0.95)],
        max: s.at(-1),
      };
    };
    for (let cycle = 0; cycle < config.cycles; cycle++) {
      const fileIndex = cycle % config.files.length,
        file = config.files[fileIndex],
        memoryBefore = process.memoryUsage(),
        openStart = stamp("open-" + cycle);
      const editor = await lumine.workspace.open(file);
      editor.getElement().setUpdatedSynchronously(false);
      editor.update({ undoGroupingInterval: 0 });
      await editor.whenGrammarSettled();
      const row =
        cycle % 3 === 0
          ? Math.floor(editor.getLineCount() / 2)
          : cycle % 3 === 1
            ? Math.max(0, editor.getLastBufferRow() - 100)
            : editor.getLastBufferRow();
      editor.setCursorBufferPosition([row, editor.lineTextForBufferRow(row).length]);
      editor.scrollToCursorPosition({ mode: "center" });
      await sleep(500);
      const frames = [],
        events = [];
      let running = true,
        last;
      const frame = (t) => {
        if (!running) return;
        if (last !== undefined) frames.push({ at: t, duration: t - last });
        last = t;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      await new Promise((r) => requestAnimationFrame(r));
      const start = stamp("typing-" + cycle);
      let edits = 0;
      for (let i = 0; i < config.count; i++) {
        const due = start + i * config.interval;
        await sleep(Math.max(0, due - performance.now()));
        const at = performance.now();
        if (i < Math.floor(config.count / 2)) editor.insertText(i % 12 === 11 ? " " : "a");
        else editor.insertNewline();
        edits++;
        events.push({
          at,
          delay: at - due,
          duration: performance.now() - at,
          key: i < Math.floor(config.count / 2) ? "letter" : "enter",
        });
      }
      await editor.whenGrammarSettled();
      await sleep(200);
      running = false;
      const end = stamp("finish-" + cycle),
        memoryAfter = process.memoryUsage();
      stamp("undo-" + cycle);
      if (config.undo !== false) {
        for (let i = 0; i < edits; i++) editor.undo();
        await editor.whenGrammarSettled();
        expect(hash(editor.getText())).toBe(hashes[fileIndex]);
      }
      const asynchronousUpdates =
        editor.getBuffer().getLanguageMode().shouldParseSynchronously?.() === false;
      const close = stamp("close-" + cycle);
      editor.destroy();
      const entry = {
        cycle,
        fileIndex,
        row,
        grammar: editor.getGrammar().scopeName,
        asynchronousUpdates,
        openStart,
        start,
        end,
        close,
        memoryBefore,
        memoryAfter,
        command: stats(events.map((e) => e.duration)),
        delay: stats(events.map((e) => e.delay)),
        frame: stats(frames.map((e) => e.duration)),
        events,
        frames,
      };
      result.cycles.push(entry);
      console.log("CYCLE", JSON.stringify({ ...entry, events: undefined, frames: undefined }));
      fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2));
      await sleep(150);
    }
    for (let i = 0; i < config.files.length; i++)
      expect(hash(fs.readFileSync(config.files[i]))).toBe(hashes[i]);
    await sleep(250);
    longObserver.disconnect();
    result.finished = true;
    fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2));
  }, 900000);
});
