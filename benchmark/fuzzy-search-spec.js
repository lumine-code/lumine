// Isolated renderer benchmark. LUMINE_FUZZY_BENCHMARK supplies corpus/output paths.
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const Module = require("node:module");

describe("Fuzzy search performance", () => {
  it("measures candidate preparation and query-to-layout latency", async () => {
    jasmine.useRealClock();
    const config = JSON.parse(process.env.LUMINE_FUZZY_BENCHMARK);
    const referenceDirectory =
      config.nativeReferenceDirectory || config.javascriptReferenceDirectory;
    // A frozen baseline is explicitly supplied by the experiment. Only this
    // process's prototypes are replaced; source and installed modules stay intact.
    if (referenceDirectory) {
      const directory = referenceDirectory;
      const compile = (name, overrides = {}) => {
        const filename = path.resolve(__dirname, "../src", name + ".js");
        const instance = new Module(filename, module);
        instance.filename = filename;
        instance.paths = Module._nodeModulePaths(path.dirname(filename));
        const localRequire = Module.createRequire(filename);
        instance.require = (request) => overrides[request] ?? localRequire(request);
        instance._compile(
          fs.readFileSync(path.join(directory, name + "-before.js"), "utf8"),
          filename,
        );
        return instance.exports;
      };
      const implementation = require(
        path.join(directory, config.javascriptReferenceDirectory ? "library" : "native.node"),
      );
      const matcher = compile("fuzzy-matcher", {
        "@lumine-code/fuzzy-search": implementation,
        // Frozen pre-migration sources are loaded only when explicitly supplied.
        "@lumine-code/fast-fuzzy": implementation,
        "@lumine-code/fuzzy-native": implementation,
      });
      const oldModel = compile("select-list-model");
      const currentModel = require("../src/select-list-model");
      for (const name of Object.getOwnPropertyNames(oldModel.prototype))
        if (name !== "constructor")
          Object.defineProperty(
            currentModel.prototype,
            name,
            Object.getOwnPropertyDescriptor(oldModel.prototype, name),
          );
      const oldView = compile("select-list", { "./fuzzy-matcher": matcher });
      const currentView = require("../src/select-list");
      for (const name of ["matchCandidates", "getMatchIndices"])
        currentView.prototype[name] = oldView.prototype[name];
    }
    const corpusBytes = fs.readFileSync(config.corpus);
    const corpus = JSON.parse(corpusBytes);
    const workspace = lumine.workspace.getElement();
    workspace.style.width = "1100px";
    workspace.style.height = "850px";
    jasmine.attachToDOM(workspace);
    const summarize = (samples) => {
      const sorted = samples.slice().sort((a, b) => a - b);
      return {
        median: sorted[Math.floor(sorted.length / 2)],
        p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
        samples,
      };
    };
    const results = [];
    for (const count of config.sizes || [1000, 10000, 100000]) {
      const items = Array.from({ length: count }, (_, id) => ({
        id,
        text:
          id < corpus.length
            ? corpus[id]
            : `project-${Math.floor(id / corpus.length)}/${corpus[id % corpus.length]}`,
        distance: 1 + (id % 5),
      }));
      for (const algorithm of config.algorithms || ["command-t", "fuzzaldrin"]) {
        const times = new Map();
        for (let sample = -2; sample < (config.samples || 9); sample++) {
          const start = performance.now();
          const list = lumine.workspace.buildSelectList({
            items,
            getItemId: (item) => item.id,
            search: {
              getFilterText: (item) => item.text,
              algorithm,
              // File-search-like dynamic modifier, applied before final ordering.
              scoreModifier:
                algorithm === "command-t" ? (score, item) => score / item.distance : undefined,
            },
            renderItem: (item, { highlight }) => {
              const li = document.createElement("li");
              li.appendChild(highlight(item.text));
              return li;
            },
          });
          const host = lumine.workspace.addSelectList(list);
          const record = (id, duration) => {
            if (sample < 0) return;
            if (!times.has(id)) times.set(id, []);
            times.get(id).push(duration);
          };
          try {
            await host.show();
            list.getElement().getBoundingClientRect();
            record("open", performance.now() - start);
            for (const [name, query] of [
              ["first", "s"],
              ["extend", "se"],
              ["extend-more", "sel"],
              ["backspace", "se"],
              ["repeat", "s"],
              ["selective", "slv"],
              ["miss", "notfound987654321"],
            ]) {
              const before = performance.now();
              const update = list.setQuery(query);
              const synchronous = performance.now() - before;
              await update;
              const rect = list.getElement().getBoundingClientRect();
              record(name, performance.now() - before);
              record(name + "/sync", synchronous);
              expect(rect.width).toBeGreaterThan(0);
              expect(list.getQuery()).toBe(query);
              if (name === "miss") expect(list.getMatchCount()).toBe(0);
              else expect(list.getMatchCount()).toBeGreaterThan(0);
            }
          } finally {
            await host.destroy();
            await list.destroy();
          }
        }
        for (const [name, samples] of times)
          results.push({ id: `${algorithm}/${count}/${name}`, ...summarize(samples) });
      }
    }
    const hash = (data) => crypto.createHash("sha256").update(data).digest("hex");
    const sources = {};
    for (const name of ["fuzzy-matcher", "select-list", "select-list-model"]) {
      const filename = referenceDirectory
        ? path.join(referenceDirectory, name + "-before.js")
        : path.resolve(__dirname, "../src", name + ".js");
      sources[name] = hash(fs.readFileSync(filename));
    }
    const libraryDirectory = config.javascriptReferenceDirectory
      ? path.join(config.javascriptReferenceDirectory, "library/lib")
      : !config.nativeReferenceDirectory
        ? path.dirname(require.resolve("@lumine-code/fuzzy-search"))
        : null;
    const libraryHash = libraryDirectory
      ? hash(
          JSON.stringify(
            fs
              .readdirSync(libraryDirectory)
              .sort()
              .map((name) => [name, hash(fs.readFileSync(path.join(libraryDirectory, name)))]),
          ),
        )
      : hash(fs.readFileSync(path.join(config.nativeReferenceDirectory, "native.node")));
    fs.writeFileSync(
      config.output,
      JSON.stringify(
        {
          runtime: process.versions,
          label: config.label,
          corpusHash: hash(corpusBytes),
          driverHash: hash(fs.readFileSync(__filename)),
          sources,
          libraryHash,
          results,
        },
        null,
        2,
      ),
    );
  }, 240000);
});
