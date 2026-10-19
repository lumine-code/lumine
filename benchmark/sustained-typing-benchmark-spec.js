// Run with an isolated LUMINE_HOME and LUMINE_TYPING_BENCH_CONFIG JSON:
// { file, output, packages: [...], count: 90, interval: 33.333 }.
// The supplied file is opened and edited in memory, undone, and never saved.
const fs = require("node:fs");
const crypto = require("node:crypto");

describe("Sustained typing with scheduled rendering", () => {
  it("records command latency, event backlog and animation frames", async () => {
    jasmine.useRealClock();
    const config = JSON.parse(process.env.LUMINE_TYPING_BENCH_CONFIG);
    const count = config.count ?? 90;
    const interval = config.interval ?? 33.333;
    for (const name of config.packages) await lumine.packages.activatePackage(name);
    const workspace = lumine.workspace.getElement();
    workspace.style.width = "1200px";
    workspace.style.height = "850px";
    jasmine.attachToDOM(workspace);
    const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");
    const bytes = fs.readFileSync(config.file);
    const original = bytes.toString("utf8");
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const stats = (values) => {
      const sorted = values.slice().sort((a, b) => a - b);
      return {
        median: sorted[Math.floor(sorted.length * 0.5)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        max: sorted.at(-1),
      };
    };
    const result = {
      bytes: bytes.length,
      inputHash: hash(bytes),
      count,
      interval,
      packages: config.packages,
      cases: [],
    };
    for (const position of config.positions ?? ["middle", "near-end", "end"]) {
      for (const key of ["letter", "enter"]) {
        const editor = await lumine.workspace.open(config.file);
        editor.getElement().setUpdatedSynchronously(false);
        editor.update({ undoGroupingInterval: 0 });
        await editor.whenGrammarSettled();
        const row =
          position === "middle"
            ? Math.floor(editor.getLineCount() / 2)
            : position === "near-end"
              ? Math.max(0, editor.getLastBufferRow() - 100)
              : editor.getLastBufferRow();
        editor.setCursorBufferPosition([row, editor.lineTextForBufferRow(row).length]);
        editor.scrollToCursorPosition({ mode: "center" });
        await sleep(500);
        const commands = [],
          delays = [],
          frames = [];
        let running = true,
          previous;
        const frame = (now) => {
          if (!running) return;
          if (previous !== undefined) frames.push(now - previous);
          previous = now;
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const start = performance.now();
        for (let i = 0; i < count; i++) {
          const due = start + i * interval;
          await sleep(Math.max(0, due - performance.now()));
          delays.push(performance.now() - due);
          const before = performance.now();
          if (key === "enter") editor.insertNewline();
          else editor.insertText("a");
          commands.push(performance.now() - before);
        }
        await editor.whenGrammarSettled();
        await sleep(150);
        running = false;
        const scopes = [];
        for (
          let r = Math.max(0, row - 2);
          r <= Math.min(editor.getLastBufferRow(), row + count + 2);
          r++
        ) {
          const length = editor.lineTextForBufferRow(r).length;
          for (const column of [0, Math.min(5, length), length]) {
            scopes.push(editor.scopeDescriptorForBufferPosition([r, column]).scopes);
          }
        }
        result.cases.push({
          position,
          key,
          row,
          grammar: editor.getGrammar().scopeName,
          outputHash: hash(editor.getText()),
          syntaxHash: hash(JSON.stringify(scopes)),
          firstCommand: commands[0],
          commands: stats(commands),
          delays: stats(delays),
          frames: stats(frames),
          raw: { commands, delays, frames },
        });
        for (let i = 0; i < count; i++) editor.undo();
        expect(hash(editor.getText())).toBe(hash(original));
        editor.destroy();
        fs.writeFileSync(config.output, JSON.stringify(result, null, 2));
      }
    }
    expect(hash(fs.readFileSync(config.file))).toBe(result.inputHash);
  }, 600000);
});
