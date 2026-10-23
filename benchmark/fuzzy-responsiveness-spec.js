const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

describe("Fuzzy renderer responsiveness diagnostics", () => {
  it("distinguishes event-loop service from time spent awaiting layout", async () => {
    jasmine.useRealClock();
    const config = JSON.parse(process.env.LUMINE_FUZZY_RESPONSIVENESS);
    if (config.packages.length > 1) throw new Error("Use a fresh process per picker");
    const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
    const snapshot = require("./fuzzy-review-snapshot")(config.snapshot);
    const monitor = await require("./fuzzy-responsiveness-monitor")();
    const inputs = [];
    let recording = true;
    const input = (event) => {
      if (event.code !== "F24") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (recording) inputs.push({ at: performance.now(), timestamp: event.timeStamp });
    };
    window.addEventListener("keydown", input, true);
    const frames = async (count = 3) => {
      for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame);
    };
    const workspace = lumine.workspace.getElement();
    workspace.style.width = "1100px";
    workspace.style.height = "850px";
    jasmine.attachToDOM(workspace);
    globalThis.__fuzzyGo = false;
    globalThis.__fuzzyRelease = false;
    fs.writeFileSync(config.ready, "ready");
    while (!globalThis.__fuzzyGo) await delay(20);
    const result = { config, samples: [], validation: [], inputs, runtime: process.versions };
    const measure = async (id, action, state = {}) => {
      const sample = await monitor.measure(id, action);
      Object.assign(sample, state);
      result.samples.push(sample);
      return sample;
    };
    const busy = (duration) => {
      const end = performance.now() + duration;
      while (performance.now() < end) {
        /* deliberate positive control */
      }
    };
    for (let i = 0; i < (config.calibrationSamples ?? 3); i++) {
      await frames();
      await measure(`control/frames/${i}`, () => frames(2), { callerRoute: "animation-frame" });
      await frames();
      await measure(`control/idle/${i}`, () => delay(40), { callerRoute: "node-timer-promise" });
      await frames();
      await measure(
        `control/busy/${i}`,
        () =>
          new Promise((resolve) => {
            require("node:timers").setTimeout(() => {
              busy(80);
              resolve();
            }, 0);
          }),
        { callerRoute: "node-timer" },
      );
      await frames();
      await measure(
        `control/dom-busy/${i}`,
        () =>
          new Promise((resolve) => {
            const message = `fuzzy-native-busy-${i}`;
            const listener = (event) => {
              if (event.source !== window || event.data !== message) return;
              window.removeEventListener("message", listener);
              busy(80);
              resolve();
            };
            window.addEventListener("message", listener);
            window.postMessage(message, "*");
          }),
        { callerRoute: "dom-message" },
      );
      await frames();
    }
    const workerEvents = [];
    const Client = snapshot.load("lumine/src/fuzzy-search-worker-client.js");
    const request = Client.prototype.request;
    const close = Client.prototype.close;
    // A Jasmine spy would retain every 1024-string message in its call history,
    // changing the garbage-collection workload we are trying to measure.
    Client.prototype.request = function (type, data, options) {
      if (type === "init" || (type === "add" && data.offset === 0))
        workerEvents.push({ at: performance.now(), type });
      return request.call(this, type, data, options);
    };
    Client.prototype.close = function (...args) {
      if (!this.closed) workerEvents.push({ at: performance.now(), type: "close" });
      return close.apply(this, args);
    };
    const corpusBytes = fs.readFileSync(config.corpus);
    const corpus = JSON.parse(corpusBytes);
    const activeEditor = await lumine.workspace.open(config.activeFile);
    try {
      for (const name of config.packages ?? ["fuzzy-explorer", "fuzzy-files"]) {
        const pkg = await lumine.packages.loadPackage(name);
        pkg.mainModule = snapshot.load(`${name}/lib/main.js`);
        await lumine.packages.activatePackage(name);
        const main = pkg.mainModule;
        if (name === "fuzzy-explorer") {
          spyOn(main, "loadCache").and.returnValue(false);
          main.items = corpus;
        } else {
          await lumine.project.setPaths([config.project]);
          spyOn(lumine.project, "observeFilePaths").and.callFake((callback) => {
            callback({ added: corpus, removed: [], indexing: false });
            return new (require("@lumine-code/event-kit").Disposable)();
          });
          spyOn(lumine.project, "isIndexing").and.returnValue(false);
        }
        const host = name === "fuzzy-explorer" ? main.ensureSelectList() : main.ensureFinder();
        const list = host.getModel();
        const layout = () => list.getElement().getBoundingClientRect();
        await host.show();
        if (!list.getItemCount()) await list.reload();
        await list.workerPreparation?.promise;
        expect(list.getItemCount()).toBe(corpus.length);
        await host.hide();
        for (const mode of config.modes ?? ["retained", "cold"]) {
          for (let i = 0; i < (config.openSamples ?? 20); i++) {
            await frames();
            const previous = list.workerPreparation?.client;
            const events = workerEvents.length;
            const sample = await measure(`${name}/${mode}/open/${i}`, async () => {
              if (mode === "cold") list.clearWorkerMatcher();
              await host.show();
              layout();
            });
            sample.reusedWorker = previous === list.workerPreparation?.client;
            sample.workerEvents = workerEvents.slice(events);
            if (mode === "retained") expect(sample.reusedWorker).toBe(true);
            if (mode === "cold") list.clearWorkerMatcher();
            await frames();
            await host.hide();
          }
          await host.show();
          await list.workerPreparation?.promise;
          await host.hide();
        }
        await host.show();
        await list.workerPreparation?.promise;
        for (let sample = 0; sample < (config.querySamples ?? 2); sample++) {
          for (const [index, query] of ["s", "se", "sel", "se", "s", ""].entries()) {
            await frames();
            if (config.coldQueries && index === 0) list.clearWorkerMatcher();
            const events = workerEvents.length;
            const phase = config.coldQueries ? "query-cold" : "query";
            const timing = await measure(
              `${name}/${phase}/${sample}/${query || "empty"}`,
              async () => {
                await list.setQuery(query);
                layout();
              },
            );
            timing.matchCount = list.getMatchCount();
            timing.workerEvents = workerEvents.slice(events);
            expect(list.getQuery()).toBe(query);
            expect(list.isFiltering()).toBe(false);
          }
        }
        // Full-list arrays/JSON are expensive diagnostic allocations. Keep the
        // correctness pass after every timed sample in this single-picker process.
        await frames();
        result.monitor = await monitor.finish();
        recording = false;
        console.timeStamp("fuzzy-validation:start");
        if (config.coldQueries) list.clearWorkerMatcher();
        for (const query of ["s", "se", "sel", "se", "s", ""]) {
          await list.setQuery(query);
          const ordered = list.getFilteredItems().map((item) => list.getItemId(item));
          result.validation.push({
            name,
            query,
            count: ordered.length,
            hash: hash(JSON.stringify(ordered)),
          });
        }
        console.timeStamp("fuzzy-validation:end");
        await lumine.packages.deactivatePackage(name);
      }
      result.monitor = await monitor.finish();
      recording = false;
      result.workerEvents = workerEvents;
      result.corpusHash = hash(corpusBytes);
      result.sources = snapshot.sources;
      result.workerLibraryHashes = snapshot.workerLibraryHashes;
      result.snapshot = JSON.parse(fs.readFileSync(path.join(config.snapshot, "manifest.json")));
      result.driverHash = hash(fs.readFileSync(__filename));
      fs.writeFileSync(config.output, JSON.stringify(result));
      fs.writeFileSync(config.done, "done");
      while (!globalThis.__fuzzyRelease) await delay(20);
    } finally {
      await monitor.finish();
      Client.prototype.request = request;
      Client.prototype.close = close;
      window.removeEventListener("keydown", input, true);
      activeEditor.destroy();
      await lumine.project.setPaths([]);
    }
  }, 300000);
});
