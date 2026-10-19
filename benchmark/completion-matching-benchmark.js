// Isolated completion ranking, repeated-query and highlighting workloads.
// Run each source variant in a fresh Node process; see docs/completion-pipeline.md.
const fs = require("node:fs"),
  path = require("node:path"),
  vm = require("node:vm"),
  Module = require("node:module"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf("--" + name);
  return index < 0 ? fallback : args[index + 1];
};
const core = path.resolve(option("core", path.join(__dirname, "..")));
const pack = path.resolve(option("package", path.join(core, "../autocomplete")));
const out = path.resolve(option("output", "completion-matching-results.json"));
const variant = option("label", "current");
const hasModel = fs.existsSync(path.join(pack, "lib/completion-matches.js"));
const matcher = fs.existsSync(path.join(core, "src/completion-matcher.js"))
  ? require(path.join(core, "src/completion-matcher"))
  : null;
const native = require(path.join(core, "src/fuzzy-matcher"));
let nativeCalls = 0;
const counted = {};
for (const method of ["setCandidates", "match"])
  counted[method] = (...args) => {
    nativeCalls++;
    return native[method](...args);
  };
global.lumine = {
  config: { get: () => false },
  tools: {
    fuzzyMatcher: counted,
    completionMatcher: matcher ? { createQuery: matcher.createQuery } : undefined,
  },
};
const runtimeFile = path.join(pack, "lib/completion-runtime.js"),
  localRequire = Module.createRequire(runtimeFile);
const moduleObject = { exports: {} };
vm.compileFunction(
  fs.readFileSync(runtimeFile, "utf8"),
  ["require", "module", "exports", "__filename", "__dirname"],
  { filename: runtimeFile },
)(
  (name) => (name === "lumine" ? {} : localRequire(name)),
  moduleObject,
  moduleObject.exports,
  runtimeFile,
  path.dirname(runtimeFile),
);
const runtime = moduleObject.exports;
const matches = hasModel ? require(path.join(pack, "lib/completion-matches")) : null;
const samples = Number(option("samples", 15)),
  warmups = Number(option("warmups", 5));
assert(Number.isInteger(samples) && samples >= 7);
assert(Number.isInteger(warmups) && warmups >= 1);
const summary = (values) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], samples: values };
};
const results = [];
(async () => {
  const makeItems = (count) =>
    Array.from({ length: count }, (_, i) => ({
      text: `candidate_word_${i}`,
      filterText: i % 5 === 0 ? `custom_${i}` : undefined,
    }));
  for (const count of [100, 1000, 10000])
    for (const mode of ["cold", "repeat", "extend"]) {
      const elapsed = [],
        calls = [];
      for (let sample = -warmups; sample < samples; sample++) {
        const items = makeItems(count);
        const owner = {};
        if (mode !== "cold")
          runtime.filterSuggestions.call(owner, items, {
            prefix: mode === "extend" ? "cx" : "caw",
          });
        global.gc?.();
        const before = nativeCalls,
          start = performance.now();
        const result = runtime.filterSuggestions.call(owner, items, {
          prefix: mode === "extend" ? "cxa" : "caw",
        });
        const duration = performance.now() - start;
        assert.equal(result.length, mode === "extend" ? 0 : count * 0.8);
        if (sample >= 0) {
          elapsed.push(duration);
          calls.push(nativeCalls - before);
        }
      }
      results.push({ id: `rank/${mode}/${count}`, ...summary(elapsed), nativeCalls: calls });
    }
  for (const mode of ["cold", "rerender"]) {
    const elapsed = [],
      calls = [];
    for (let sample = -warmups; sample < samples; sample++) {
      const items = makeItems(1000),
        result = runtime.filterSuggestions(items, { prefix: "caw" }).slice(0, 20);
      const render = () =>
        result.map((item) =>
          hasModel
            ? matches.characterMatches(item, item.text, "caw")
            : counted.match(item.text, "caw", { recordMatchIndexes: true })?.matchIndexes,
        );
      if (mode === "rerender") render();
      const before = nativeCalls,
        start = performance.now();
      const indices = render(),
        duration = performance.now() - start;
      for (const value of indices) assert(value.length === 3);
      if (sample >= 0) {
        elapsed.push(duration);
        calls.push(nativeCalls - before);
      }
    }
    results.push({ id: `highlight/${mode}/20`, ...summary(elapsed), nativeCalls: calls });
  }
  const TextBuffer = require(path.join(core, "src/text-buffer"));
  for (const mode of ["legacy", "compact"]) {
    if (mode === "compact" && !TextBuffer.prototype.findWordCandidates) continue;
    const elapsed = [];
    let resultBytes;
    for (let sample = -warmups; sample < samples; sample++) {
      const buffer = new TextBuffer("banana bandana ban_ana bandaid band bNa\n".repeat(6000));
      const start = performance.now();
      const result = await (mode === "compact"
        ? buffer.findWordCandidates("bna", { extraWordCharacters: "_", position: [5000, 3] })
        : buffer.findWordsWithSubsequence("bna", "_", 20));
      const duration = performance.now() - start;
      assert.equal(result.length, 5);
      if (sample >= 0) elapsed.push(duration);
      resultBytes = JSON.stringify(result).length;
      buffer.destroy();
    }
    results.push({ id: `words/${mode}/6000`, ...summary(elapsed), resultBytes });
  }
  const digest = (directory) => {
    const files = [];
    function walk(rel) {
      for (const e of fs.readdirSync(path.join(directory, rel), { withFileTypes: true })) {
        const name = path.posix.join(rel, e.name);
        if (e.isDirectory()) walk(name);
        else
          files.push([
            name,
            crypto
              .createHash("sha256")
              .update(fs.readFileSync(path.join(directory, name)))
              .digest("hex"),
          ]);
      }
    }
    walk(directory === core ? "src" : "lib");
    return crypto.createHash("sha256").update(JSON.stringify(files.sort())).digest("hex");
  };
  const report = {
    variant,
    node: process.version,
    samples,
    warmups,
    gcAfterRankSetup: Boolean(global.gc),
    hasModel,
    sourceHashes: { core: digest(core), package: digest(pack) },
    driverHash: crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex"),
    results,
  };
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(results.map(({ id, median, resultBytes }) => ({ id, median, resultBytes })));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
