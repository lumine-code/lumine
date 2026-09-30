const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--"))
    throw new Error(`--${name} requires a value`);
  return args[index + 1];
}
const mode = args.includes("--release") || option("profile") === "release" ? "release" : "quick";
const output = path.resolve(
  option(
    "output",
    path.join(
      path.dirname(ROOT),
      ".dev",
      "benchmarks",
      "injection-routing",
      new Date().toISOString().replace(/[:.]/g, "-"),
    ),
  ),
);
const baseline = path.resolve(option("baseline", path.join(output, "baseline", "lumine")));
const candidate = path.resolve(option("source", ROOT));
const config = {
  mode,
  samples: Number(option("samples", mode === "release" ? 30 : 3)),
  warmups: Number(option("warmups", mode === "release" ? 5 : 1)),
  layers: option("layers", "500,5000").split(",").map(Number),
  cases: option("cases", "leading,trailing,leading-length-changing,inside").split(","),
  suites: option("suites", "injections").split(","),
  markers: option("markers", "1000,10000").split(",").map(Number),
  listeners: option("listeners", "none,sparse,dense").split(","),
  markerCases: option("marker-cases", "leading,leading-insert,leading-delete").split(","),
  representatives: option("representatives", "html,vue,ipython").split(","),
  representativeCases: option(
    "representative-cases",
    "leading,leading-insert,leading-delete,inside",
  ).split(","),
  representativeBlocks: Number(option("representative-blocks", 50)),
  grammarRoot: path.resolve(option("grammar-root", path.dirname(ROOT))),
};
if (
  !Number.isInteger(config.samples) ||
  config.samples < 1 ||
  !Number.isInteger(config.warmups) ||
  config.warmups < 0 ||
  config.layers.some((count) => !Number.isInteger(count) || count < 1 || count > 99999) ||
  config.cases.some(
    (kind) =>
      ![
        "leading",
        "trailing",
        "leading-length-changing",
        "leading-insert",
        "leading-delete",
        "inside",
      ].includes(kind),
  ) ||
  config.suites.some((suite) => !["injections", "markers", "representative"].includes(suite)) ||
  config.markers.some((count) => !Number.isInteger(count) || count < 1 || count > 99999) ||
  config.listeners.some((kind) => !["none", "sparse", "dense"].includes(kind)) ||
  [...config.markerCases, ...config.representativeCases].some(
    (kind) =>
      ![
        "leading",
        "trailing",
        "leading-length-changing",
        "leading-insert",
        "leading-delete",
        "inside",
      ].includes(kind),
  ) ||
  config.representatives.some((name) => !["html", "vue", "ipython"].includes(name)) ||
  !Number.isInteger(config.representativeBlocks) ||
  config.representativeBlocks < 1 ||
  config.representativeBlocks > 5000
)
  throw new Error("Invalid benchmark samples, counts, suites or cases");
const electron = path.resolve(option("electron", require("electron")));
const git = (...argv) => execFileSync("git", argv, { cwd: ROOT, encoding: "utf8" }).trim();
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function percentile(values, fraction) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(reports) {
  const assets = grammarFingerprint(reports[0]);
  if (reports.some((report) => grammarFingerprint(report) !== assets))
    throw new Error("Grammar, query, provider or runtime WASM changed between processes");
  return reports[0].results.map((first) => {
    const cases = reports.map((report) => report.results.find(({ id }) => id === first.id));
    if (
      cases.some(
        (result) =>
          !result ||
          result.checksum.sha256 !== first.checksum.sha256 ||
          result.corpusSha256 !== first.corpusSha256,
      )
    )
      throw new Error(`Unstable semantic output: ${first.id}`);
    const metrics = Object.fromEntries(
      Object.keys(first.samplesMs).map((key) => {
        const values = cases.flatMap((result) => result.samplesMs[key]);
        const median = percentile(values, 0.5);
        return [
          key,
          {
            medianMs: median,
            madMs: percentile(
              values.map((value) => Math.abs(value - median)),
              0.5,
            ),
            p95Ms: percentile(values, 0.95),
            p99Ms: percentile(values, 0.99),
            maxMs: Math.max(...values),
            samples: values.length,
            processMediansMs: cases.map((result) => percentile(result.samplesMs[key], 0.5)),
          },
        ];
      }),
    );
    return {
      id: first.id,
      checksum: first.checksum,
      corpusSha256: first.corpusSha256,
      metrics,
      diagnostics: cases.map((result) => result.diagnostics),
    };
  });
}

function grammarFingerprint(report) {
  return JSON.stringify({
    runtimeWasm: report.runtime.runtimeWasm.sha256,
    assets: report.runtime.grammarAssets.map((grammar) => ({
      scopeName: grammar.scopeName,
      descriptor: grammar.descriptor.sha256,
      wasm: grammar.wasm.sha256,
      queries: grammar.queries.map((query) => query.sha256),
    })),
    providers: (report.runtime.injectionProviders || []).map((provider) => provider.sha256),
    providerModules: (report.runtime.injectionProviderModules || []).map(
      (provider) => provider.sha256,
    ),
  });
}

function confidence(before, after) {
  if (before.length < 5 || after.length < 5) return null;
  let seed = 0x51a79;
  const draw = (values) =>
    percentile(
      values.map(() => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return values[seed % values.length];
      }),
      0.5,
    );
  const ratios = [];
  for (let index = 0; index < 2000; index++) {
    const baselineMedian = draw(before);
    const candidateMedian = draw(after);
    if (baselineMedian > 0) ratios.push(candidateMedian / baselineMedian);
  }
  return ratios.length
    ? {
        method: "2000 deterministic bootstrap resamples of fresh-process medians",
        lower: percentile(ratios, 0.025),
        upper: percentile(ratios, 0.975),
      }
    : null;
}

async function run(source, label, index) {
  if (!fs.existsSync(path.join(source, "src", "tree-sitter-language-mode.js")))
    throw new Error(`No source at ${source}`);
  const file = path.join(output, `${label}-${index}.json`);
  if (fs.existsSync(file))
    throw new Error(`Refusing to overwrite ${file}; use a new --output directory`);
  const home = path.join(output, "homes", `${label}-${index}`);
  fs.mkdirSync(home, { recursive: true });
  const logPath = path.join(output, `${label}-${index}.log`);
  const log = fs.createWriteStream(logPath);
  console.log(`${label} process ${index}: ${config.samples} samples, ${config.warmups} warmups`);
  const child = spawn(
    electron,
    [
      "--no-sandbox",
      source,
      "-f",
      "--test",
      path.join(ROOT, "benchmark", "injection-routing-spec.js"),
    ],
    {
      cwd: source,
      windowsHide: true,
      env: {
        ...process.env,
        LUMINE_HOME: home,
        LUMINE_RESOURCE_PATH: source,
        LUMINE_INJECTION_ROUTING_CONFIG: JSON.stringify({ ...config, source }),
        LUMINE_INJECTION_ROUTING_OUTPUT: file,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  log.end();
  if (code !== 0 || !fs.existsSync(file))
    throw new Error(`${label} failed (${code}); inspect ${logPath}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  if (fs.existsSync(path.join(output, "summary.json")))
    throw new Error("Use a new --output directory; summary.json already exists");
  const compare = args.includes("--compare");
  const order = compare
    ? ["baseline", "candidate", "candidate", "baseline"]
    : [option("label", "candidate")];
  const blocks = mode === "release" ? (compare ? 3 : 5) : 1;
  const provenance = {
    editorSha: git("rev-parse", "HEAD"),
    workingTree: git("status", "--short"),
    benchmarkSha256: sha256(
      fs.readFileSync(path.join(ROOT, "benchmark", "injection-routing-spec.js")),
    ),
    runnerSha256: sha256(fs.readFileSync(__filename)),
    source: candidate,
    baselineSource: compare ? baseline : null,
    baselineManifest:
      compare && fs.existsSync(path.join(path.dirname(baseline), "manifest.json"))
        ? JSON.parse(fs.readFileSync(path.join(path.dirname(baseline), "manifest.json"), "utf8"))
        : null,
    expectedElectron: require(path.join(ROOT, "package.json")).electronVersion,
    powerProfile: option("power-profile", "unrecorded"),
    frozenAt: new Date().toISOString(),
  };
  const reports = {};
  for (let block = 0; block < blocks; block++) {
    for (const label of order) {
      reports[label] ??= [];
      reports[label].push(
        await run(
          compare && label === "baseline" ? baseline : candidate,
          label,
          reports[label].length + 1,
        ),
      );
    }
  }
  const summary = {
    schemaVersion: 1,
    config,
    order,
    blocks,
    provenance,
    results: Object.fromEntries(
      Object.entries(reports).map(([label, entries]) => [label, summarize(entries)]),
    ),
  };
  if (
    compare &&
    grammarFingerprint(reports.baseline[0]) !== grammarFingerprint(reports.candidate[0])
  )
    throw new Error("Baseline/candidate grammar, query, provider or runtime WASM mismatch");
  if (compare)
    summary.comparison = summary.results.baseline.map((before) => {
      const after = summary.results.candidate.find(({ id }) => id === before.id);
      if (
        !after ||
        after.checksum.sha256 !== before.checksum.sha256 ||
        after.corpusSha256 !== before.corpusSha256
      )
        throw new Error(`Baseline/candidate parity mismatch: ${before.id}`);
      return {
        id: before.id,
        metrics: Object.fromEntries(
          Object.entries(before.metrics).map(([key, value]) => [
            key,
            {
              before: value,
              after: after.metrics[key],
              medianImprovementPercent: value.medianMs
                ? (1 - after.metrics[key].medianMs / value.medianMs) * 100
                : null,
              ratio95Interval: confidence(
                value.processMediansMs,
                after.metrics[key].processMediansMs,
              ),
            },
          ]),
        ),
      };
    });
  fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`Saved ${path.join(output, "summary.json")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
