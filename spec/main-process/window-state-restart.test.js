const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const electron = require("electron");

test("immediate native changes survive full process restarts", { timeout: 120000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-window-state-restart-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profile = path.join(directory, "electron");
  fs.mkdirSync(profile);
  const fixture = path.resolve(__dirname, "../fixtures/window-state-process.js");
  for (const stage of [
    "initial",
    "maximize",
    "unmaximize",
    "resize",
    "resize-maximize",
    "minimize",
    "final",
    "fullscreen",
    "verify-fullscreen",
    "leave-fullscreen",
    "verify-normal",
  ]) {
    const env = {
      ...process.env,
      LUMINE_WINDOW_STATE_STAGE: stage,
      LUMINE_WINDOW_STATE_PROFILE: profile,
      LUMINE_WINDOW_STATE_DIRECTORY: path.join(directory, "state"),
    };
    for (const key of ["CI", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_TEST_CONTEXT"]) {
      delete env[key];
    }
    const child = spawn(electron, ["--no-sandbox", fixture], {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (data) => (output += data));
    }
    const timeout = setTimeout(() => child.kill(), 15000);
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }).finally(() => clearTimeout(timeout));
    assert.equal(code, 0, `${stage}: ${output}`);
    const line = output.split(/\r?\n/).find((value) => value.startsWith("WINDOW_STATE_RESULT "));
    assert.ok(line, `${stage}: missing native result: ${output}`);
    const result = JSON.parse(line.slice("WINDOW_STATE_RESULT ".length));
    assert.equal(
      result.saved.maximized,
      [
        "maximize",
        "resize-maximize",
        "minimize",
        "final",
        "fullscreen",
        "verify-fullscreen",
      ].includes(stage),
    );
    assert.equal(result.saved.fullScreen, ["fullscreen", "verify-fullscreen"].includes(stage));
    const expectedBounds = ["initial", "maximize", "unmaximize"].includes(stage)
      ? { x: 120, y: 100, width: 720, height: 540 }
      : stage === "resize"
        ? { x: 150, y: 120, width: 760, height: 560 }
        : { x: 180, y: 140, width: 800, height: 580 };
    assert.deepEqual(result.saved.bounds, expectedBounds, `${stage}: saved normal bounds`);
  }
});
