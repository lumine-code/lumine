const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const {
  inside,
  validate,
  fixtureFiles,
  pngSize,
  check,
  readmeWithImages,
  accept,
} = require("./demo");

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-demo-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const recipe = () => ({
  version: 1,
  viewport: { width: 1100, height: 730 },
  scenes: [{ id: "first", file: "demo.png", caption: "A real view.", run() {}, ready() {} }],
});
const image = { file: "demo.png", label: "A real view." };

test("recipes reject traversal, duplicate scenes and missing readiness checks", () => {
  assert.equal(validate(recipe()).scenes.length, 1);
  for (const change of [
    (r) => {
      r.scenes[0].file = "../demo.png";
    },
    (r) => {
      r.scenes.push({ ...r.scenes[0] });
    },
    (r) => {
      delete r.scenes[0].ready;
    },
    (r) => {
      r.viewport.width = NaN;
    },
    (r) => {
      r.scenes[0].caption = "bad\ncaption";
    },
    (r) => {
      r.version = 2;
    },
    (r) => {
      r.before = "run a command";
    },
    (r) => {
      r.secrets = { token: "value" };
    },
    (r) => {
      r.scenes[0].drag = [0, 0, 100, 100];
    },
    (r) => {
      r.scenes[0].timeout = Infinity;
    },
    (r) => {
      r.scenes[0].allowNotifications = "false";
    },
  ]) {
    const r = recipe();
    change(r);
    assert.throws(() => validate(r));
  }
});

test("fixtures are deterministic and cannot escape through parent paths or symlinks", (t) => {
  const dir = temporary(t);
  fs.writeFileSync(path.join(dir, "b.txt"), "b");
  fs.mkdirSync(path.join(dir, "nested"));
  fs.writeFileSync(path.join(dir, "nested", "a.txt"), "a");
  assert.deepEqual(
    fixtureFiles(dir).map((i) => i.file),
    ["b.txt", "nested/a.txt"],
  );
  assert.throws(() => inside(dir, "../outside"));
  assert.throws(() => inside(dir, dir));
  fs.symlinkSync(
    path.join(dir, "nested"),
    path.join(dir, "link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => fixtureFiles(dir), /Symlink/);
  assert.throws(() => inside(dir, "link/a.txt"), /Symlink/);
});

test("README updates stay inside Features and preserve concurrent prose", () => {
  const original =
    "# package\n\nDescription.\n\n## Features\n\n- A newly edited feature.\n\n![Old](.github/demo.png)\n\n![Old second](.github/demo-2.png)\n\n## Usage\n\nUser edits here.\n";
  const result = readmeWithImages(original, [image]);
  assert.ok(result.includes("- A newly edited feature."));
  assert.ok(result.endsWith("## Usage\n\nUser edits here.\n"));
  assert.ok(!result.includes("Old"));
  assert.equal(readmeWithImages(result, [image]), result);
  assert.throws(() => readmeWithImages("# package\n", [image]), /Features/);
});

function runFixture(t) {
  const dir = temporary(t);
  fs.mkdirSync(path.join(dir, "images"));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=",
    "base64",
  );
  const file = path.join(dir, "images", "demo.png");
  fs.writeFileSync(file, png);
  const run = {
    version: 1,
    status: "complete",
    package: "example",
    expectedFiles: ["demo.png"],
    images: [{ ...image, ...pngSize(file) }],
  };
  const save = () => fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(run));
  save();
  return { dir, run, save, file };
}

test("check refuses incomplete, tampered, missing and duplicate images", (t) => {
  const { dir, run, save, file } = runFixture(t);
  assert.equal(check(dir).images.length, 1);
  run.status = "failed";
  save();
  assert.throws(() => check(dir), /incomplete/);
  run.status = "complete";
  run.expectedFiles.push("demo-2.png");
  save();
  assert.throws(() => check(dir), /Missing/);
  fs.copyFileSync(file, path.join(dir, "images", "demo-2.png"));
  run.images.push({ ...run.images[0], file: "demo-2.png" });
  save();
  assert.throws(() => check(dir), /Duplicate/);
  run.images.pop();
  run.expectedFiles.pop();
  save();
  fs.appendFileSync(file, "tampered");
  assert.throws(() => check(dir), /Changed image/);
  fs.writeFileSync(file, "not png");
  assert.throws(() => check(dir), /Invalid PNG/);
});

test("accept checks the package and recipe before writing, then preserves unrelated assets", async (t) => {
  const { dir, run, save } = runFixture(t);
  const target = temporary(t);
  fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: "wrong" }));
  await assert.rejects(accept(dir, target), /another package/);
  assert.ok(!fs.existsSync(path.join(target, ".github")));
  fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: "example" }));
  fs.writeFileSync(path.join(target, "demo.js"), "module.exports = {};");
  await assert.rejects(accept(dir, target), /Recipe changed/);
  run.recipeHash = crypto.createHash("sha256").update("module.exports = {};").digest("hex");
  run.sources = { package: { revision: "test" }, "one-theme": { revision: "theme" } };
  save();
  fs.writeFileSync(path.join(target, "README.md"), "# example\n\n## Features\n\n- Preserved.\n");
  fs.mkdirSync(path.join(target, ".github"));
  fs.writeFileSync(path.join(target, ".github", "other.png"), "keep");
  await accept(dir, target);
  assert.equal(fs.readFileSync(path.join(target, ".github", "other.png"), "utf8"), "keep");
  assert.ok(fs.readFileSync(path.join(target, "README.md"), "utf8").includes("- Preserved."));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(target, ".github", "demo.json"))).images.length,
    1,
  );
});
