// Isolated renderer benchmark. LUMINE_PARSER_CADENCE_CONFIG supplies
// { out, files, packages, scenarios? }. Files are never saved. Each file runs at 60, 30
// and 8 commands per second; results include settlement and renderer CPU.
const fs = require("fs"),
  path = require("path"),
  crypto = require("crypto");
describe("Foreground, parser settlement and process CPU by cadence", () => {
  it("compares rapid and isolated edits with the active fleet", async () => {
    jasmine.useRealClock();
    const config = JSON.parse(process.env.LUMINE_PARSER_CADENCE_CONFIG),
      sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
      hash = (x) => crypto.createHash("sha256").update(x).digest("hex");
    for (const name of config.packages) await lumine.packages.activatePackage(name);
    const workspace = lumine.workspace.getElement();
    workspace.style.width = "1200px";
    workspace.style.height = "850px";
    jasmine.attachToDOM(workspace);
    const result = { cases: [], packages: config.packages },
      stats = (a) => {
        const s = a.slice().sort((a, b) => a - b);
        return {
          median: s[Math.floor(s.length * 0.5)],
          p95: s[Math.floor(s.length * 0.95)],
          max: s.at(-1),
        };
      };
    for (let fileIndex = 0; fileIndex < config.files.length; fileIndex++)
      for (const [count, interval] of config.scenarios ?? [
        [240, 16.667],
        [120, 33.333],
        [24, 125],
      ]) {
        const file = config.files[fileIndex],
          original = hash(fs.readFileSync(file)),
          editor = await lumine.workspace.open(file);
        editor.getElement().setUpdatedSynchronously(false);
        editor.update({ undoGroupingInterval: 0 });
        await editor.whenGrammarSettled();
        editor.setCursorBufferPosition([
          Math.max(0, editor.getLastBufferRow() - 100),
          config.cursorColumn ?? 0,
        ]);
        editor.scrollToCursorPosition({ mode: "center" });
        await sleep(500);
        const durations = [],
          delays = [],
          frames = [];
        let running = true,
          last;
        const frame = (t) => {
          if (!running) return;
          if (last !== undefined) frames.push(t - last);
          last = t;
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
        await new Promise((r) => requestAnimationFrame(r));
        const cpuStart = process.cpuUsage(),
          start = performance.now();
        for (let i = 0; i < count; i++) {
          await sleep(Math.max(0, start + i * interval - performance.now()));
          const t = performance.now();
          if (i % 60 === 59) editor.insertNewline();
          else editor.insertText(i % 12 === 11 ? " " : "a");
          durations.push(performance.now() - t);
          delays.push(t - start - i * interval);
        }
        const inputEnd = performance.now();
        await editor.whenGrammarSettled();
        const settled = performance.now(),
          cpu = process.cpuUsage(cpuStart);
        running = false;
        const mode = editor.getBuffer().getLanguageMode();
        expect(mode.tree.revision).toBe(editor.getBuffer().getTextRevision());
        if (config.requireValidSyntax) expect(mode.tree.rootNode.hasError).toBe(false);
        expect(mode.tree.input).toBe(editor.getText());
        result.cases.push({
          fileIndex,
          grammar: editor.getGrammar().scopeName,
          incremental: mode.tree.incremental,
          count,
          interval,
          command: stats(durations),
          backlog: stats(delays),
          frame: stats(frames),
          settlementMs: settled - inputEnd,
          cpuMs: (cpu.user + cpu.system) / 1000,
          wallMs: settled - start,
          inputHash: original,
          outputHash: hash(editor.getText()),
          syntaxHash: hash(mode.tree.rootNode.toString()),
          raw: { durations, delays, frames },
        });
        editor.destroy();
        await sleep(500);
        expect(hash(fs.readFileSync(file))).toBe(original);
        fs.writeFileSync(path.join(config.out, "result.json"), JSON.stringify(result, null, 2));
      }
    result.finished = true;
    fs.writeFileSync(path.join(config.out, "result.json"), JSON.stringify(result, null, 2));
  }, 600000);
});
