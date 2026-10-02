const { performance } = require("perf_hooks");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--baseline")) {
  throw new Error("Usage: node benchmark/repository-routing-benchmark.js [--baseline <ref>]");
}
if (args.length) {
  const { execFileSync } = require("child_process");
  const path = require("path");
  const Module = require("module");
  const filename = require.resolve("../src/repository-registry");
  const source = execFileSync("git", ["show", `${args[1]}:src/repository-registry.js`], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    windowsHide: true,
  });
  // Load only the historical registry in memory. Its dependencies, fixture,
  // lookup counters and timing driver remain identical to the current arm.
  const historical = new Module(filename, module);
  historical.filename = filename;
  historical.paths = Module._nodeModulePaths(path.dirname(filename));
  require.cache[filename] = historical;
  historical._compile(source, filename);
  historical.loaded = true;
}
const {
  createRoutingFixture,
  routingEvents,
  countRoutingWork,
} = require("./helpers/repository-routing-fixture");

const runs = Number(process.env.LUMINE_REPOSITORY_ROUTING_RUNS || 3);
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 10) {
  throw new Error("LUMINE_REPOSITORY_ROUTING_RUNS must be an integer from 1 to 10");
}

const results = [];
for (const repositoryCount of [128, 512]) {
  const { registry, repositories } = createRoutingFixture(repositoryCount);
  try {
    for (const eventCount of [1000, 8000]) {
      for (const kind of ["working-tree", "metadata"]) {
        const events = routingEvents(repositories, eventCount, kind);
        const counted = countRoutingWork(registry, () => {
          const plan = registry.repositoryRefreshPlanForFileChanges(events);
          return { refreshedRepositories: plan.pending.size };
        });
        const timings = [];
        for (let run = 0; run < runs; run++) {
          const started = performance.now();
          registry.repositoryRefreshPlanForFileChanges(events);
          timings.push(performance.now() - started);
        }
        timings.sort((left, right) => left - right);
        const result = {
          repositoryCount,
          eventCount,
          kind,
          runs,
          refreshedRepositories: counted.refreshedRepositories,
          ...counted.metrics,
          medianMs: Number(timings[Math.floor(timings.length / 2)].toFixed(2)),
          maxMs: Number(timings.at(-1).toFixed(2)),
        };
        results.push(result);
        process.stderr.write(
          `${repositoryCount} repositories, ${eventCount} ${kind} events: ${result.medianMs} ms; ${result.entryVisits} entry visits\n`,
        );
      }
    }
  } finally {
    registry.destroy();
  }
}
process.stdout.write(
  JSON.stringify(
    { platform: process.platform, node: process.version, baseline: args[1] || null, results },
    null,
    2,
  ) + "\n",
);
