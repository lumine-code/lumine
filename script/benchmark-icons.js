const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const IconRegistry = require("../src/icon-registry");

const COUNT = Number.parseInt(process.env.LUMINE_ICON_BENCHMARK_COUNT ?? "5000", 10);
const LIVE_COUNT = Math.min(
  COUNT,
  Number.parseInt(process.env.LUMINE_ICON_BENCHMARK_LIVE_COUNT ?? "1000", 10),
);

function measure(callback) {
  const started = performance.now();
  callback();
  return Number((performance.now() - started).toFixed(2));
}

function targetsFor(label, count = COUNT) {
  const root = path.resolve(`icon-benchmark-${label}`);
  return Array.from({ length: count }, (_, index) => path.join(root, `entry-${index}.js`));
}

function fakeElement() {
  const classes = new Set();
  return {
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      contains: (name) => classes.has(name),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
    },
  };
}

function benchmarkKnownFiles() {
  const paths = targetsFor("files");
  const registry = new IconRegistry();
  const originalLstat = fs.lstatSync;
  let lstats = 0;
  fs.lstatSync = (...args) => {
    lstats++;
    return originalLstat(...args);
  };
  try {
    const hints = { directory: false };
    const coldMs = measure(() =>
      paths.forEach((filePath) => registry.iconFor({ path: filePath, hints })),
    );
    const firstLstats = lstats;
    const warmMs = measure(() =>
      paths.forEach((filePath) => registry.iconFor({ path: filePath, hints })),
    );
    return { coldMs, warmMs, coldLstats: firstLstats, warmLstats: lstats - firstLstats };
  } finally {
    fs.lstatSync = originalLstat;
    registry.destroy();
  }
}

function benchmarkRepositoryMetadata() {
  const paths = targetsFor("repositories");
  let lookups = 0;
  let onChange;
  let repository = null;
  const registry = new IconRegistry();
  registry.attachRepositories({
    getForPath() {
      lookups++;
      return repository;
    },
    onDidChange(callback) {
      onChange = callback;
      return { dispose() {} };
    },
  });
  const hints = { directory: true, symlink: false };
  const coldMs = measure(() =>
    paths.forEach((filePath) => registry.iconFor({ path: filePath, hints })),
  );
  const firstLookups = lookups;
  const warmMs = measure(() =>
    paths.forEach((filePath) => registry.iconFor({ path: filePath, hints })),
  );
  const warmLookups = lookups - firstLookups;
  const singlePath = paths[0];
  const singleIterations = 100000;
  const singleTotalMs = measure(() => {
    for (let index = 0; index < singleIterations; index++) {
      registry.iconFor({ path: singlePath, hints });
    }
  });

  const applications = paths
    .slice(0, LIVE_COUNT)
    .map((filePath) =>
      registry.applyTo(fakeElement(), { path: filePath, hints }, { render: false, setData: false }),
    );
  const beforeEmptyEvent = lookups;
  const emptyEventMs = measure(() => {
    onChange({ routingChangedPrefixes: [] });
    registry.flushRepositoryInvalidations();
  });
  const emptyEventLookups = lookups - beforeEmptyEvent;

  const unrelatedPrefixes = Array.from({ length: 1000 }, (_, index) =>
    path.resolve(`unrelated-icon-prefix-${index}`),
  );
  const beforeUnrelatedPrefixes = lookups;
  const unrelatedPrefixesMs = measure(() => {
    onChange({ routingChangedPrefixes: unrelatedPrefixes });
    registry.flushRepositoryInvalidations();
  });
  const unrelatedPrefixLookups = lookups - beforeUnrelatedPrefixes;

  const root = path.dirname(paths[0]);
  repository = {
    relativize: (filePath) => path.relative(root, filePath),
    isSubmodule: () => false,
  };
  const beforeStableRouting = lookups;
  const stableRoutingMs = measure(() => {
    onChange({ routingChangedPrefixes: [root] });
    registry.flushRepositoryInvalidations();
  });
  const stableRoutingLookups = lookups - beforeStableRouting;

  repository = {
    relativize: (filePath) => path.relative(root, filePath),
    isSubmodule: () => true,
  };
  const beforeRoutingChange = lookups;
  const routingChangeMs = measure(() => {
    onChange({ routingChangedPrefixes: [root] });
    registry.flushRepositoryInvalidations();
  });
  const routingChangeLookups = lookups - beforeRoutingChange;

  for (const application of applications) application.dispose();
  registry.destroy();
  return {
    coldMs,
    warmMs,
    coldLookups: firstLookups,
    warmLookups,
    singleWarmMicroseconds: Number(((singleTotalMs * 1000) / singleIterations).toFixed(3)),
    emptyEventMs,
    emptyEventLookups,
    unrelatedPrefixCount: unrelatedPrefixes.length,
    unrelatedPrefixesMs,
    unrelatedPrefixLookups,
    stableRoutingEntries: LIVE_COUNT,
    stableRoutingMs,
    stableRoutingLookups,
    routingChangeEntries: LIVE_COUNT,
    routingChangeMs,
    routingChangeLookups,
  };
}

const result = {
  count: COUNT,
  files: benchmarkKnownFiles(),
  repositories: benchmarkRepositoryMetadata(),
};

assert.strictEqual(result.files.coldLstats, 0, "known files must not be stat'd");
assert.strictEqual(result.files.warmLstats, 0, "warm known files must not be stat'd");
assert.strictEqual(result.repositories.coldLookups, COUNT, "cold paths resolve routing once");
assert.strictEqual(result.repositories.warmLookups, 0, "warm paths reuse repository metadata");
assert.strictEqual(result.repositories.emptyEventLookups, 0, "non-routing events do no icon work");
assert.strictEqual(
  result.repositories.unrelatedPrefixLookups,
  0,
  "unrelated routing prefixes do no path lookups",
);
assert.strictEqual(
  result.repositories.stableRoutingLookups,
  result.repositories.stableRoutingEntries,
  "routing changes eagerly recheck only live paths",
);
assert.strictEqual(
  result.repositories.routingChangeLookups,
  result.repositories.routingChangeEntries,
  "changed routing eagerly rechecks only live paths",
);

console.log(JSON.stringify(result, null, 2));
