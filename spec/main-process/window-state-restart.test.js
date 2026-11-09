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
  let targets;
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
      LUMINE_WINDOW_STATE_TARGET_BOUNDS: targets ? JSON.stringify(targets) : "",
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
    if (!targets) {
      targets = result.targets;
      for (const bounds of Object.values(targets)) {
        assert.ok(bounds.x >= result.area.x && bounds.y >= result.area.y);
        assert.ok(bounds.x + bounds.width <= result.area.x + result.area.width);
        assert.ok(bounds.y + bounds.height <= result.area.y + result.area.height);
      }
    }
    assert.deepEqual(result.targets, targets);
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
      `${stage}: saved maximized state: ${JSON.stringify(result)}`,
    );
    assert.equal(
      result.saved.fullScreen,
      ["fullscreen", "verify-fullscreen"].includes(stage),
      `${stage}: saved fullscreen state: ${JSON.stringify(result)}`,
    );
    const expectedBounds = ["initial", "maximize", "unmaximize"].includes(stage)
      ? targets.initial
      : stage === "resize"
        ? targets.resized
        : targets.final;
    assert.deepEqual(result.saved.bounds, expectedBounds, `${stage}: saved normal bounds`);
  }
});
