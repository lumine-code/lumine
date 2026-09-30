const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const WORKSPACE = path.dirname(ROOT);
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}
const mode = args.includes("--release") || option("profile") === "release" ? "release" : "quick";
const runDirectory = path.resolve(
  option(
    "output",
    path.join(
      WORKSPACE,
      ".dev",
      "benchmarks",
      "display-legacy",
      new Date().toISOString().replace(/[:.]/g, "-"),
    ),
  ),
);
const config = { mode, samples: mode === "release" ? 30 : 3, warmups: mode === "release" ? 5 : 1 };
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const git = (...arguments_) =>
  execFileSync("git", arguments_, { cwd: ROOT, encoding: "utf8" }).trim();

function freeze() {
  const destination = path.join(runDirectory, "baseline");
  if (fs.existsSync(path.join(destination, "manifest.json"))) return destination;
  fs.mkdirSync(destination, { recursive: true });
  const source = path.join(destination, "lumine");
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  for (const relative of files) {
    const target = path.join(source, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), target);
  }
  fs.mkdirSync(path.join(source, "benchmark"), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, "benchmark", "display-legacy-spec.js"),
    path.join(source, "benchmark", "display-legacy-spec.js"),
  );
  const installedAddon = path.dirname(require.resolve("@lumine-code/superstring/package.json"));
  const frozenAddon = path.join(destination, "superstring");
  fs.cpSync(installedAddon, frozenAddon, { recursive: true });
  for (const relative of files.filter((file) => file.startsWith("src/") && file.endsWith(".js"))) {
    const target = path.join(source, relative);
    const contents = fs.readFileSync(target, "utf8");
    if (contents.includes('require("@lumine-code/superstring")')) {
      fs.writeFileSync(
        target,
        contents.replaceAll(
          'require("@lumine-code/superstring")',
          `require(${JSON.stringify(frozenAddon)})`,
        ),
      );
    }
  }
  fs.symlinkSync(
    path.join(ROOT, "node_modules"),
    path.join(source, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const manifest = {
    schemaVersion: 1,
    editorSha: git("rev-parse", "HEAD"),
    superstringPin: require(path.join(ROOT, "package.json")).dependencies[
      "@lumine-code/superstring"
    ],
    workingTree: git("status", "--short"),
    frozenAt: new Date().toISOString(),
    source,
    frozenAddon,
    benchmarkSha256: sha256(
      fs.readFileSync(path.join(ROOT, "benchmark", "display-legacy-spec.js")),
    ),
    sourceSha256: sha256(
      files.map((file) => `${file}:${sha256(fs.readFileSync(path.join(ROOT, file)))}`).join("\n"),
    ),
  };
  fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2));
  return destination;
}

async function run(source, label, index) {
  const output = path.join(runDirectory, `${label}-${index}.json`);
  const log = fs.createWriteStream(path.join(runDirectory, `${label}-${index}.log`));
  const electron = require("electron");
  const home = path.join(runDirectory, "homes", `${label}-${index}`);
  fs.mkdirSync(home, { recursive: true });
  console.log(`${label} process ${index}: ${config.samples} samples, ${config.warmups} warmups`);
  const child = spawn(
    electron,
    [
      "--no-sandbox",
      "--enable-logging",
      source,
      "-f",
      "--dev",
      "--test",
      path.join(source, "benchmark", "display-legacy-spec.js"),
    ],
    {
      cwd: source,
      windowsHide: true,
      env: {
        ...process.env,
        LUMINE_HOME: home,
        LUMINE_RESOURCE_PATH: source,
        LUMINE_DISPLAY_BENCHMARK_WORKSPACE: WORKSPACE,
        LUMINE_DISPLAY_BENCHMARK_CONFIG: JSON.stringify(config),
        LUMINE_DISPLAY_BENCHMARK_OUTPUT: output,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  log.end();
  if (code !== 0 || !fs.existsSync(output))
    throw new Error(
      `${label} process ${index} failed (${code}); inspect ${output.replace(/\.json$/, ".log")}`,
    );
  return JSON.parse(fs.readFileSync(output, "utf8"));
}

function percentile(values, fraction) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(reports) {
  return reports[0].results.map((first) => {
    const cases = reports.map((report) => report.results.find(({ id }) => id === first.id));
    if (cases.some((result) => !result || result.checksum !== first.checksum))
      throw new Error(`Unstable benchmark output: ${first.id}`);
    const metrics = {};
    for (const metric of Object.keys(first.samplesMs)) {
      const values = cases.flatMap((result) => result.samplesMs[metric]);
      metrics[metric] = {
        medianMs: percentile(values, 0.5),
        p95Ms: percentile(values, 0.95),
        samples: values.length,
        processMediansMs: cases.map((result) => percentile(result.samplesMs[metric], 0.5)),
      };
    }
    return { id: first.id, checksum: first.checksum, metrics };
  });
}

function bootstrapImprovement(before, after) {
  if (before.length < 5 || after.length < 5) return null;
  let seed = 0x51a79;
  const pick = (values) => {
    const sample = values.map(() => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return values[seed % values.length];
    });
    return percentile(sample, 0.5);
  };
  const samples = [];
  for (let index = 0; index < 2000; index++) {
    const baseline = pick(before);
    const candidate = pick(after);
    if (baseline > 0) samples.push((1 - candidate / baseline) * 100);
  }
  if (!samples.length) return null;
  return {
    method: "2000 deterministic resamples of fresh-process medians",
    lowerPercent: percentile(samples, 0.025),
    upperPercent: percentile(samples, 0.975),
  };
}

function compare(baseline, candidate) {
  return baseline.map((before) => {
    const after = candidate.find(({ id }) => id === before.id);
    if (!after || after.checksum !== before.checksum)
      throw new Error(`Baseline/candidate parity mismatch: ${before.id}`);
    const metrics = {};
    for (const [metric, value] of Object.entries(before.metrics)) {
      metrics[metric] = {
        before: value,
        after: after.metrics[metric],
        improvementPercent:
          value.medianMs === 0 ? null : (1 - after.metrics[metric].medianMs / value.medianMs) * 100,
        improvement95PercentInterval: bootstrapImprovement(
          value.processMediansMs,
          after.metrics[metric].processMediansMs,
        ),
      };
    }
    return { id: before.id, metrics };
  });
}

async function main() {
  fs.mkdirSync(runDirectory, { recursive: true });
  if (
    args.includes("--compare") &&
    !fs.existsSync(path.join(runDirectory, "baseline", "manifest.json"))
  ) {
    throw new Error("Capture the baseline in this --output directory before running --compare.");
  }
  if (!["baseline", "candidate"].includes(option("phase", "baseline"))) {
    throw new Error("--phase must be baseline or candidate.");
  }
  const frozen = freeze();
  if (args.includes("--freeze")) {
    console.log(`Frozen baseline: ${frozen}`);
    return;
  }
  const baselineSource = JSON.parse(
    fs.readFileSync(path.join(frozen, "manifest.json"), "utf8"),
  ).source;
  // The corpus is shared; production sources and the native addon stay frozen.
  fs.copyFileSync(
    path.join(ROOT, "benchmark", "display-legacy-spec.js"),
    path.join(baselineSource, "benchmark", "display-legacy-spec.js"),
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(frozen, "manifest.json"), "utf8"));
  manifest.benchmarkSha256 = sha256(
    fs.readFileSync(path.join(ROOT, "benchmark", "display-legacy-spec.js")),
  );
  fs.writeFileSync(path.join(frozen, "manifest.json"), JSON.stringify(manifest, null, 2));
  const phases = args.includes("--compare")
    ? ["baseline", "candidate", "candidate", "baseline"]
    : [option("phase", "baseline")];
  // Three complete ABBA blocks give six fresh processes per variant (>= five).
  const processes = mode === "release" ? (args.includes("--compare") ? 3 : 5) : 1;
  const reports = { baseline: [], candidate: [] };
  for (let round = 0; round < processes; round++) {
    for (const phase of phases) {
      const source = phase === "baseline" ? baselineSource : ROOT;
      reports[phase].push(await run(source, phase, reports[phase].length + 1));
    }
  }
  const summary = {
    schemaVersion: 1,
    config,
    order: phases,
    baselineManifest: JSON.parse(fs.readFileSync(path.join(frozen, "manifest.json"), "utf8")),
    candidateSha: git("rev-parse", "HEAD"),
    candidateWorkingTree: git("status", "--short"),
    baseline: reports.baseline.length ? summarize(reports.baseline) : null,
    candidate: reports.candidate.length ? summarize(reports.candidate) : null,
  };
  if (summary.baseline && summary.candidate)
    summary.comparison = compare(summary.baseline, summary.candidate);
  fs.writeFileSync(path.join(runDirectory, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`Saved ${path.join(runDirectory, "summary.json")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
