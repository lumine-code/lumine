// Run through the isolated editor test runner. LUMINE_FIRST_EDIT_CONFIG supplies
// {out, files, packages, positions?, operations?, cycles?, count?, interval?}.
// Input files are never saved. Frame recording includes two post-settlement frames.
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
describe("First-edit syntax budget with active packages", () => {
  it("records initial input and frame costs in repeated fresh editors", async () => {
    jasmine.useRealClock();
    const config = JSON.parse(process.env.LUMINE_FIRST_EDIT_CONFIG);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");
    const stats = (values) => {
      const sorted = values.slice().sort((a, b) => a - b);
      return {
        median: sorted[Math.floor(sorted.length * 0.5)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        max: sorted.at(-1),
      };
    };
    for (const name of config.packages) await lumine.packages.activatePackage(name);
    const workspace = lumine.workspace.getElement();
    workspace.style.width = "1200px";
    workspace.style.height = "850px";
    jasmine.attachToDOM(workspace);
    const result = { packages: config.packages, cases: [] };
    for (let cycle = 0; cycle < (config.cycles ?? 1); cycle++)
      for (let fileIndex = 0; fileIndex < config.files.length; fileIndex++)
        for (const position of config.positions ?? ["middle", "end"])
          for (const operation of config.operations ?? ["letter", "enter"]) {
            const file = config.files[fileIndex],
              inputHash = hash(fs.readFileSync(file));
            const editor = await lumine.workspace.open(file);
            editor.getElement().setUpdatedSynchronously(false);
            editor.update({ undoGroupingInterval: 0 });
            await editor.whenGrammarSettled();
            const row =
              position === "middle"
                ? Math.floor(editor.getLastBufferRow() / 2)
                : Math.max(0, editor.getLastBufferRow() - 100);
            editor.setCursorBufferPosition([row, 0]);
            editor.scrollToCursorPosition({ mode: "center" });
            await sleep(500);
            const mode = editor.getBuffer().getLanguageMode(),
              initiallySynchronous = mode.shouldParseSynchronously();
            const events = [],
              frames = [],
              longTasks = [];
            let running = true,
              last;
            const observer = new PerformanceObserver((list) => {
              for (const entry of list.getEntries())
                longTasks.push({ at: entry.startTime, duration: entry.duration });
            });
            observer.observe({ type: "longtask", buffered: false });
            const frame = (at) => {
              if (!running) return;
              if (last !== undefined) frames.push({ at, duration: at - last });
              last = at;
              requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
            await new Promise((resolve) => requestAnimationFrame(resolve));
            const count = config.count ?? 60,
              interval = config.interval ?? 16.667,
              cpuStart = process.cpuUsage(),
              start = performance.now();
            for (let i = 0; i < count; i++) {
              await sleep(Math.max(0, start + i * interval - performance.now()));
              const at = performance.now();
              if (operation === "enter") editor.insertNewline();
              else editor.insertText(i % 12 === 11 ? " " : "a");
              events.push({
                at,
                duration: performance.now() - at,
                delay: at - start - i * interval,
              });
            }
            const inputEnd = performance.now();
            await editor.whenGrammarSettled();
            await editor.autoIndentAtTransactionEndPromise;
            await editor.whenGrammarSettled();
            const settled = performance.now(),
              cpu = process.cpuUsage(cpuStart);
            await new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            );
            running = false;
            await sleep(100);
            observer.disconnect();
            expect(mode.tree.revision).toBe(editor.getBuffer().getTextRevision());
            expect(mode.tree.input).toBe(editor.getText());
            result.cases.push({
              cycle,
              fileIndex,
              position,
              operation,
              grammar: editor.getGrammar().scopeName,
              count,
              interval,
              initiallySynchronous,
              finallySynchronous: mode.shouldParseSynchronously(),
              first: events[0].duration,
              firstTwoMax: Math.max(...events.slice(0, 2).map((e) => e.duration)),
              firstFrame: frames.find((f) => f.at > start)?.duration,
              initialFrames: stats(
                frames.filter((f) => f.at > start && f.at <= start + 250).map((f) => f.duration),
              ),
              command: stats(events.map((e) => e.duration)),
              frame: stats(frames.filter((f) => f.at > start).map((f) => f.duration)),
              settlementMs: settled - inputEnd,
              cpuMs: (cpu.user + cpu.system) / 1000,
              inputHash,
              outputHash: hash(editor.getText()),
              syntaxHash: hash(mode.tree.rootNode.toString()),
              longTasks: longTasks.filter((t) => t.at >= start && t.at < settled),
              raw: { start, inputEnd, settled, events, frames },
            });
            editor.destroy();
            await sleep(300);
            expect(hash(fs.readFileSync(file))).toBe(inputHash);
            fs.writeFileSync(path.join(config.out, "result.json"), JSON.stringify(result, null, 2));
          }
    result.finished = true;
    fs.writeFileSync(path.join(config.out, "result.json"), JSON.stringify(result, null, 2));
  }, 600000);
});
