const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const Module = require("node:module");

describe("Fleet fuzzy interaction performance", () => {
  it("measures the actual file pickers through layout", async () => {
    jasmine.useRealClock();
    const config = JSON.parse(process.env.LUMINE_FUZZY_FLEET);
    if (config.snapshot && (config.reference || config.library))
      throw new Error("Coherent snapshots cannot be mixed with historical overrides");
    const snapshot = config.snapshot ? require("./fuzzy-review-snapshot")(config.snapshot) : null;
    const library = snapshot?.library ?? require("@lumine-code/fuzzy-search");
    if (config.library) library.Matcher = require(config.library).Matcher;
    const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
    let matching = snapshot?.load("lumine/src/fuzzy-matcher.js") ?? lumine.tools.fuzzyMatcher;
    const sources = snapshot?.sources ?? {};
    const compile = (file, original, overrides = {}) => {
      const filename = path.resolve(original);
      const instance = new Module(filename, module);
      instance.filename = filename;
      instance.paths = Module._nodeModulePaths(path.dirname(filename));
      const localRequire = Module.createRequire(filename);
      instance.require = (name) => overrides[name] ?? localRequire(name);
      instance._compile(fs.readFileSync(file, "utf8"), filename);
      return instance.exports;
    };
    if (config.reference) {
      matching = compile(
        path.join(config.reference, "fuzzy-matcher-before.js"),
        path.resolve(__dirname, "../src/fuzzy-matcher.js"),
        { "@lumine-code/fast-fuzzy": library, "@lumine-code/fuzzy-search": library },
      );
      const oldModel = compile(
        path.join(config.reference, "select-list-model-before.js"),
        path.resolve(__dirname, "../src/select-list-model.js"),
      );
      const model = require("../src/select-list-model");
      for (const key of Object.getOwnPropertyNames(oldModel.prototype))
        if (key !== "constructor")
          Object.defineProperty(
            model.prototype,
            key,
            Object.getOwnPropertyDescriptor(oldModel.prototype, key),
          );
      const oldView = compile(
        path.join(config.reference, "select-list-before.js"),
        path.resolve(__dirname, "../src/select-list.js"),
        { "./fuzzy-matcher": matching },
      );
      const view = require("../src/select-list");
      for (const key of Object.getOwnPropertyNames(oldView.prototype))
        if (key !== "constructor")
          Object.defineProperty(
            view.prototype,
            key,
            Object.getOwnPropertyDescriptor(oldView.prototype, key),
          );
      view.prototype.update = require("../src/input-dialog").prototype.update;
      view.prototype.prepareWorkerOnIdle = function () {};
      view.prototype.shouldSearchInWorker = () => false;
    }
    for (const name of snapshot ? [] : ["fuzzy-matcher", "select-list", "select-list-model"]) {
      const file = config.reference
        ? path.join(config.reference, `${name}-before.js`)
        : path.resolve(__dirname, "../src", `${name}.js`);
      sources[name] = hash(fs.readFileSync(file));
    }
    for (const name of snapshot
      ? [
          "input-dialog",
          "dialog-actions",
          "select-list-component",
          "select-list-host",
          "input-dialog-host",
          "modal-dialog-factory",
        ]
      : ["input-dialog", "dialog-actions", "fuzzy-search-worker", "fuzzy-search-worker-client"])
      sources[name] = hash(fs.readFileSync(path.resolve(__dirname, "../src", `${name}.js`)));
    const libraryDirectory =
      snapshot?.libraryDirectory ??
      (config.library
        ? path.join(config.library, "lib")
        : path.dirname(require.resolve("@lumine-code/fuzzy-search")));
    const libraryHash = () =>
      hash(
        JSON.stringify(
          fs
            .readdirSync(libraryDirectory)
            .sort()
            .filter((name) => /\.(js|json)$/.test(name))
            .map((name) => [name, hash(fs.readFileSync(path.join(libraryDirectory, name)))]),
        ),
      );
    const beforeLibraryHash = libraryHash();
    let activePhases = null;
    const wrap = (object, key, phase) => {
      const original = object[key];
      spyOn(object, key).and.callFake(function (...args) {
        const start = performance.now();
        try {
          return original.apply(this, args);
        } finally {
          if (activePhases)
            activePhases.set(phase, (activePhases.get(phase) || 0) + performance.now() - start);
        }
      });
    };
    if (config.phases) {
      const model =
        snapshot?.load("lumine/src/select-list-model.js") ?? require("../src/select-list-model");
      const view = snapshot?.load("lumine/src/select-list.js") ?? require("../src/select-list");
      wrap(matching, "setCandidates", "prepare");
      wrap(library.Matcher.prototype, "rank", "rank");
      wrap(model.prototype, "_normalizeSearchResults", "validate");
      wrap(model.prototype, "_applyUpdate", "model");
      wrap(view.prototype, "syncModelState", "project-view");
    }
    const corpusBytes = fs.readFileSync(config.corpus);
    const corpus = JSON.parse(corpusBytes);
    const policy = config.policy ? JSON.parse(fs.readFileSync(config.policy)) : {};
    for (const [key, value] of Object.entries(policy)) lumine.config.set(`core.${key}`, value);
    const workspace = lumine.workspace.getElement();
    workspace.style.width = "1100px";
    workspace.style.height = "850px";
    jasmine.attachToDOM(workspace);
    const activeEditor = config.activeFile ? await lumine.workspace.open(config.activeFile) : null;
    const cases = [];
    const sequence = config.queries || ["s", "se", "sel", "s", "", "a", "ab", "", "m", "ma"];
    for (const name of config.packages || ["fuzzy-explorer", "fuzzy-files"]) {
      if (snapshot) {
        const loaded = await lumine.packages.loadPackage(name);
        loaded.mainModule = snapshot.load(`${name}/lib/main.js`);
      }
      const pkg = await lumine.packages.activatePackage(name);
      const main = pkg.mainModule;
      if (name === "fuzzy-files" && config.reference) {
        const source = path.join(config.reference, "fuzzy-files-before.js");
        const previous = compile(source, path.resolve(__dirname, "../../fuzzy-files/lib/main.js"));
        for (const key of ["addItem", "relativize", "modifyScore"]) main[key] = previous[key];
        sources[name] = hash(fs.readFileSync(source));
      } else if (!snapshot)
        sources[name] = hash(fs.readFileSync(path.resolve(__dirname, `../../${name}/lib/main.js`)));
      if (name === "fuzzy-explorer") {
        spyOn(main, "loadCache").and.returnValue(false);
        main.items = corpus;
      } else {
        await lumine.project.setPaths([config.project]);
        if (config.projectCorpus) {
          const paths = JSON.parse(fs.readFileSync(config.projectCorpus));
          spyOn(lumine.project, "observeFilePaths").and.callFake((callback) => {
            callback({ added: paths, removed: [], indexing: false });
            return new (require("@lumine-code/event-kit").Disposable)();
          });
          spyOn(lumine.project, "isIndexing").and.returnValue(false);
        }
        // Review runs include the package's first metadata-helper startup and
        // initial snapshot in the first-open interval.
        if (!snapshot) await main.whenIndexed();
      }
      const times = new Map();
      const resultSets = [];
      const record = (key, value, sample) => {
        if (sample < 0) return;
        if (!times.has(key)) times.set(key, []);
        times.get(key).push(value);
      };
      let count = 0;
      let initialOpen = null;
      let initialQuery = null;
      for (let sample = -(config.warmups ?? 1); sample < (config.samples || 5); sample++) {
        const firstOpen = initialOpen === null;
        let lastOpenTick = performance.now();
        let openGap = 0;
        const openHeartbeat = setInterval(() => {
          const now = performance.now();
          openGap = Math.max(openGap, now - lastOpenTick);
          lastOpenTick = now;
        }, 4);
        const started = performance.now();
        const host = name === "fuzzy-explorer" ? main.ensureSelectList() : main.ensureFinder();
        const list = host.getModel();
        if (config.worker === false && list.props.search.worker !== false)
          await list.update({
            search: { ...list.props.search, worker: false },
          });
        if (config.cold) {
          list.clearWorkerMatcher();
          list.filterMatcher = null;
          list.filterMatcherGeneration = null;
          list.filterMatcherRecords = null;
          list.filterMatcherOptions = null;
        }
        await host.show();
        if (!list.getItemCount()) await list.reload();
        list.getElement().getBoundingClientRect();
        const openDuration = performance.now() - started;
        openGap = Math.max(openGap, performance.now() - lastOpenTick);
        clearInterval(openHeartbeat);
        record("open", openDuration, sample);
        record("open/longest-task-gap", openGap, sample);
        if (initialOpen === null) initialOpen = { duration: openDuration, longestTaskGap: openGap };
        // Preserve default startup for the initial open/query pair. Measured
        // reopen trials cannot inherit speculative preparation from opening.
        if (config.cold && !config.waitForPreparation && !firstOpen) {
          list.clearWorkerMatcher();
          list.filterMatcher = null;
          list.filterMatcherGeneration = null;
          list.filterMatcherRecords = null;
          list.filterMatcherOptions = null;
        }
        if (config.waitForPreparation && list.workerPreparation) {
          await list.workerPreparation?.promise;
          record("prepared", performance.now() - started, sample);
        }
        count = list.getMatchCount();
        expect(count).toBeGreaterThan(0);
        for (let i = 0; i < sequence.length; i++) {
          const query = sequence[i];
          activePhases = new Map();
          let lastTick = performance.now();
          let largestGap = 0;
          const heartbeat = setInterval(() => {
            const now = performance.now();
            largestGap = Math.max(largestGap, now - lastTick);
            lastTick = now;
          }, 4);
          const start = performance.now();
          const update = list.setQuery(query);
          const synchronous = performance.now() - start;
          await update;
          const rect = list.getElement().getBoundingClientRect();
          const duration = performance.now() - start;
          record(`${i}/${query || "(empty)"}`, duration, sample);
          largestGap = Math.max(largestGap, performance.now() - lastTick);
          clearInterval(heartbeat);
          record(`${i}/${query || "(empty)"}/longest-task-gap`, largestGap, sample);
          record(`${i}/${query || "(empty)"}/sync`, synchronous, sample);
          if (initialQuery === null)
            initialQuery = { query, duration, synchronous, longestTaskGap: largestGap };
          for (const [phase, duration] of activePhases)
            record(`${i}/${query || "(empty)"}/phase/${phase}`, duration, sample);
          activePhases = null;
          expect(rect.width).toBeGreaterThan(0);
          expect(list.getQuery()).toBe(query);
          if (snapshot && config.worker !== false && query)
            // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Chromium Worker, not the Node experimental global.
            expect(list.workerPreparation?.client.worker instanceof globalThis.Worker).toBe(true);
          if (sample >= 0) {
            const result = {
              query,
              count: list.getMatchCount(),
              orderedIdsHash: hash(
                JSON.stringify(list.getFilteredItems().map((item) => list.getItemId(item))),
              ),
            };
            if (sample === 0) resultSets.push(result);
            else expect(result).toEqual(resultSets[i]);
          }
        }
        await list.setQuery("");
        for (let index = 1; index <= 10; index++) {
          const start = performance.now();
          const operation = list.selectIndex(index);
          record("selection/sync", performance.now() - start, sample);
          await operation;
          list.getElement().getBoundingClientRect();
          record("selection", performance.now() - start, sample);
        }
        await host.hide();
      }
      cases.push({
        package: name,
        count,
        initialOpen,
        initialQuery,
        resultSets,
        results: Array.from(times, ([id, samples]) => {
          const ordered = samples.slice().sort((a, b) => a - b);
          return {
            id,
            median: ordered[Math.floor(ordered.length / 2)],
            p95: ordered[Math.ceil(ordered.length * 0.95) - 1],
            samples,
          };
        }),
      });
      if (name === "fuzzy-files" && config.captureProjectCorpus)
        fs.writeFileSync(
          config.captureProjectCorpus,
          JSON.stringify(main.selectList.getItems().map((x) => x.aPath)),
        );
      await lumine.packages.deactivatePackage(name);
    }
    fs.writeFileSync(
      config.output,
      JSON.stringify(
        {
          label: config.label,
          runtime: process.versions,
          corpusHash: hash(corpusBytes),
          driverHash: hash(fs.readFileSync(__filename)),
          snapshotLoaderHash: snapshot
            ? hash(fs.readFileSync(require.resolve("./fuzzy-review-snapshot")))
            : null,
          sources,
          libraryHash: beforeLibraryHash,
          workerLibraryHashes: snapshot?.workerLibraryHashes ?? null,
          snapshot: config.snapshot
            ? JSON.parse(fs.readFileSync(path.join(config.snapshot, "manifest.json")))
            : null,
          coldMatcherEachOpen: !!config.cold,
          waitsForPreparation:
            !!config.waitForPreparation && !config.reference && config.worker !== false,
          worker: config.reference ? false : config.worker !== false,
          backend: config.reference
            ? "reference"
            : config.worker === false
              ? "synchronous"
              : "worker",
          activeEditor: !!activeEditor,
          projectCorpusHash: config.projectCorpus
            ? hash(fs.readFileSync(config.projectCorpus))
            : null,
          cases,
        },
        null,
        2,
      ),
    );
    expect(libraryHash()).toBe(beforeLibraryHash);
    if (snapshot && config.worker !== false) {
      expect(Object.keys(snapshot.workerLibraryHashes).length).toBe(6);
      for (const [name, actual] of Object.entries(snapshot.workerLibraryHashes))
        expect(actual).toBe(hash(fs.readFileSync(path.join(libraryDirectory, name))));
    }
    activeEditor?.destroy();
    if (config.project) await lumine.project.setPaths([]);
  }, 300000);
});
