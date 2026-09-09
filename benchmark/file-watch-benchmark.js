const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const FileWatchService = require("../src/file-watch-service");

// Run with `node benchmark/file-watch-benchmark.js`. Each run observes a tree
// of 100 directories/1000 files, then 1000 files sharing one parent directory.
// The first arm includes worker startup; later arms reuse the same process.
// RSS is sampled without forcing GC and includes normal retained runtime heaps.
const runs = Number(process.env.LUMINE_FILE_WATCH_BENCHMARK_RUNS || 3);
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 20) {
  throw new Error("LUMINE_FILE_WATCH_BENCHMARK_RUNS must be an integer from 1 to 20");
}
const FILE_COUNT = 1000;
const DIRECTORY_COUNT = 100;
const LATENCY_SAMPLES = 20;
const temporaryRoot = fs.realpathSync.native(os.tmpdir());
const fixture = fs.mkdtempSync(path.join(temporaryRoot, "lumine-file-watch-bench-"));
const service = new FileWatchService();

function populate() {
  const tree = path.join(fixture, "tree");
  const flat = path.join(fixture, "flat");
  fs.mkdirSync(tree);
  fs.mkdirSync(flat);
  const treeFiles = [];
  const flatFiles = [];
  for (let index = 0; index < DIRECTORY_COUNT; index++) {
    const directory = path.join(tree, `directory-${index}`);
    fs.mkdirSync(directory);
    for (let fileIndex = 0; fileIndex < FILE_COUNT / DIRECTORY_COUNT; fileIndex++) {
      const filePath = path.join(directory, `file-${fileIndex}.txt`);
      fs.writeFileSync(filePath, "initial benchmark contents\n");
      treeFiles.push(filePath);
    }
  }
  for (let index = 0; index < FILE_COUNT; index++) {
    const filePath = path.join(flat, `file-${index}.txt`);
    fs.writeFileSync(filePath, "initial benchmark contents\n");
    flatFiles.push(filePath);
  }
  return [
    { name: "recursive-tree", root: tree, files: treeFiles, recursive: true },
    { name: "shared-file-parent", root: flat, files: flatFiles, recursive: false },
  ];
}

function round(milliseconds) {
  return Math.round(milliseconds * 100) / 100;
}

function latencySummary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    medianMs: round(sorted[Math.floor(sorted.length / 2)]),
    p95Ms: round(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    maxMs: round(sorted.at(-1)),
  };
}

async function measure(scenario, run) {
  process.stderr.write(`Run ${run}: ${scenario.name}\n`);
  const client = service.createClient(`benchmark:${scenario.name}:${run}`);
  const pendingWrites = new Map();
  const errors = [];
  const coldWorker = !service.worker;
  const mainRssBefore = process.memoryUsage().rss;
  const started = performance.now();
  const handles = scenario.recursive
    ? [client.watchDirectory(scenario.root, { recursive: true })]
    : scenario.files.map((filePath) => client.watchFile(filePath));
  for (const handle of handles) {
    handle.onDidChange((events) => {
      for (const event of events) {
        if (event.action !== "updated") continue;
        const pending = pendingWrites.get(event.path);
        if (!pending) continue;
        pendingWrites.delete(event.path);
        clearTimeout(pending.timeout);
        pending.resolve(performance.now() - pending.started);
      }
    });
    handle.onDidError((error) => errors.push(error));
  }
  try {
    await Promise.all(handles.map((handle) => handle.ready));
    const readyMs = performance.now() - started;
    const armed = await service.requestWorker("diagnostics");
    const mainRssArmed = process.memoryUsage().rss;
    const latencies = [];
    // Distinct files prevent a delayed duplicate notification from an earlier
    // write being mistaken for the next sample's delivery.
    for (let sample = 0; sample < LATENCY_SAMPLES; sample++) {
      const target = scenario.files[Math.floor((sample * scenario.files.length) / LATENCY_SAMPLES)];
      latencies.push(
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            pendingWrites.delete(target);
            reject(new Error(`No change delivered for ${target}`));
          }, 15000);
          pendingWrites.set(target, { resolve, started: performance.now(), timeout });
          fs.writeFileSync(
            target,
            `Run ${run}, ${scenario.name}, sample ${sample}, ${Date.now()}\n`,
          );
        }),
      );
    }
    assert.deepEqual(errors, [], "No observation errors during a benchmark scenario");
    const closing = performance.now();
    await client.close();
    const closeMs = performance.now() - closing;
    const released = await service.requestWorker("diagnostics");
    assert.equal(service.owners.size, 0, "No owner records after closing the client");
    assert.equal(
      service.diagnostics().subscriptions.length,
      0,
      "No main-process subscriptions after close",
    );
    assert.equal(released.subscriptions, 0, "No worker subscriptions after close");
    assert.equal(released.sources.length, 0, "No native directory sources after close");
    const result = {
      scenario: scenario.name,
      run,
      coldWorker,
      directories: scenario.recursive ? DIRECTORY_COUNT : 1,
      files: FILE_COUNT,
      logicalHandles: handles.length,
      readyMs: round(readyMs),
      closeMs: round(closeMs),
      latency: latencySummary(latencies),
      physicalSources: armed.sources.length,
      sourcesAtScenarioRoot: armed.sources.filter((source) => source.path === scenario.root).length,
      rssBytes: {
        mainBefore: mainRssBefore,
        mainArmed: mainRssArmed,
        mainAfterClose: process.memoryUsage().rss,
        workerArmed: armed.rssBytes,
        workerAfterClose: released.rssBytes,
      },
      remaining: {
        owners: service.owners.size,
        subscriptions: released.subscriptions,
        sources: released.sources.length,
      },
    };
    process.stderr.write(
      `  ready ${result.readyMs} ms; close ${result.closeMs} ms; median event ${result.latency.medianMs} ms; sources ${result.physicalSources}\n`,
    );
    return result;
  } finally {
    for (const pending of pendingWrites.values()) clearTimeout(pending.timeout);
    await client.close();
  }
}

async function main() {
  try {
    const scenarios = populate();
    const results = [];
    for (let run = 1; run <= runs; run++) {
      for (const scenario of scenarios) results.push(await measure(scenario, run));
    }
    await service.close();
    // Keep the service object reachable while asserting teardown; garbage
    // collection of the supervisor must not be what releases ownership.
    assert.equal(service.owners.size, 0);
    assert.equal(service.subscriptions.size, 0);
    assert.equal(service.pending.size, 0);
    assert.equal(service.worker, null);
    process.stdout.write(
      JSON.stringify(
        {
          platform: process.platform,
          architecture: process.arch,
          node: process.version,
          watcherPin: require("../package.json").dependencies["@lumine-code/watcher"],
          measuredAt: new Date().toISOString(),
          results,
          shutdown: {
            owners: 0,
            subscriptions: 0,
            pendingRequests: 0,
            sources: 0,
            workerRunning: false,
          },
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await service.close();
    const cleanupTarget = path.resolve(fixture);
    assert.equal(path.dirname(cleanupTarget), temporaryRoot);
    assert.ok(path.basename(cleanupTarget).startsWith("lumine-file-watch-bench-"));
    fs.rmSync(cleanupTarget, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
