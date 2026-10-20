const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");

test("production consumers enter the model through its flat module entry", () => {
  const members = new Set([
    "text-model.js",
    "document-core.js",
    "piece-tree.js",
    "text-patch.js",
    "change-tree.js",
    "marker-index.js",
  ]);
  assert.equal(fs.existsSync(path.join(root, "src/text-model")), false);
  for (const file of fs.readdirSync(path.join(root, "src"))) {
    if (!file.endsWith(".js") || members.has(file)) continue;
    const source = fs.readFileSync(path.join(root, "src", file), "utf8");
    assert.doesNotMatch(
      source,
      /require\(["']\.\/(?:document-core|piece-tree|text-patch|change-tree|marker-index)(?:\.js)?["']\)/,
      `${file} imports an implementation file instead of text-model.js`,
    );
  }
});

test("the internal model shares constructor identity and imports no editor or external modules", () => {
  const entry = require.resolve("../../src/text-model");
  const env = { ...process.env };
  delete env.CI;
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const Module = require('node:module'), path = require('node:path');
    const entry = ${JSON.stringify(entry)}, directory = path.dirname(entry);
    const members = new Set(['text-model.js', 'document-core.js', 'piece-tree.js',
      'text-patch.js', 'change-tree.js', 'marker-index.js'].map(file => path.join(directory, file)));
    const load = Module._load;
    Module._load = function(request, parent, ...args) {
      if (members.has(parent?.filename)) {
        if (!request.startsWith('./') || !members.has(Module._resolveFilename(request, parent)))
          throw Error('Model dependency escapes the internal boundary: ' + request);
      }
      return load.call(this, request, parent, ...args);
    };
    const { PieceTree, DocumentCore, TextPatch, MarkerIndex } = require(entry);
    const source = new PieceTree('first\\r\\n😀');
    const document = new DocumentCore(source);
    if (document.getTextSnapshot() !== source) throw Error('Snapshot copied');
    document.transact(draft => draft.replace(0, 5, 'next'));
    document.undo();
    if (document.getTextSnapshot() !== source) throw Error('Undo lost root identity');
    if (!(TextPatch.fromIndependentChanges([]) instanceof TextPatch)) throw Error('Patch identity');
    const markers = new MarkerIndex(); markers.insert(1, {row: 0, column: 0}, {row: 1, column: 2});
    if (!markers.has(1)) throw Error('Marker export');
    if (Object.keys(require.cache).some(file => file.endsWith('.node'))) throw Error('Native module loaded');
  `,
    ],
    { env, encoding: "utf8", windowsHide: true, timeout: 30000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test("Superstring is absent from the normal install and optional tests require explicit opt-in", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json")));
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"])
    assert.equal(manifest[field]?.["@lumine-code/superstring"], undefined);
  assert.equal(lock.packages["node_modules/@lumine-code/superstring"], undefined);
  assert(!Object.keys(manifest.allowScripts).some((key) => key.includes("superstring")));
  const env = { ...process.env };
  delete env.CI;
  delete env.LUMINE_NATIVE_SUPERSTRING;
  const result = spawnSync(process.execPath, [path.join(root, "script/run-document-native.js")], {
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Native comparison is opt-in/);
});

test("the optional oracle rejects a JavaScript substitute with a leftover binary", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-native-reference-"));
  const release = path.join(directory, "build", "Release");
  fs.mkdirSync(release, { recursive: true });
  const manifest = path.join(directory, "package.json");
  const entry = path.join(directory, "index.js");
  const binding = path.join(release, "superstring.node");
  try {
    fs.writeFileSync(manifest, JSON.stringify({ name: "@lumine-code/superstring" }));
    fs.writeFileSync(entry, "module.exports = {};");
    fs.writeFileSync(binding, "not an actual native addon");
    const env = { ...process.env, LUMINE_NATIVE_SUPERSTRING: directory };
    delete env.CI;
    const helper = require.resolve("../../script/native-superstring-reference");
    const result = spawnSync(
      process.execPath,
      ["-e", `require(${JSON.stringify(helper)}).load()`],
      {
        env,
        encoding: "utf8",
        windowsHide: true,
        timeout: 30000,
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /did not load its native Release binding/);
  } finally {
    for (const file of [manifest, entry, binding]) fs.unlinkSync(file);
    fs.rmdirSync(release);
    fs.rmdirSync(path.join(directory, "build"));
    fs.rmdirSync(directory);
  }
});
