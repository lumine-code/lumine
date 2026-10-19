const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1];
};
const baseline = path.resolve(
  option("baseline", path.join(root, "..", ".dev", "js-document-integration", "native-b05b9769ed")),
);
const destination = path.resolve(
  option(
    "output",
    path.join(
      root,
      "..",
      ".dev",
      "js-document-integration",
      new Date().toISOString().replace(/[:.]/g, "-"),
    ),
  ),
);
const config = {
  samples: Number(option("samples", 9)),
  warmups: Number(option("warmups", 3)),
  filter: option("filter", null),
  packages: option("packages", "").split(",").filter(Boolean),
  packageCases: args.includes("--package-cases"),
};
for (const name of config.packages) assert(/^[a-z0-9][a-z0-9-]*$/.test(name));
const repetitions = Number(option("processes", 4));
const baselineMetadata = path.join(path.dirname(baseline), "baseline.json");
const baselineRevision = option(
  "baseline-revision",
  fs.existsSync(baselineMetadata)
    ? JSON.parse(fs.readFileSync(baselineMetadata, "utf8")).revision
    : null,
);
assert(Number.isInteger(repetitions) && repetitions >= 1);
assert(Number.isInteger(config.samples) && config.samples >= 1);
assert(Number.isInteger(config.warmups) && config.warmups >= 1);
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const git = (...values) =>
  execFileSync("git", values, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const driver = "benchmark/document-editor-integration-spec.js";
const modelDriver = "benchmark/editor-superstring-benchmark.js";
const inputFiles = (directory, relative = "src") => {
  const result = [];
  for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    const file = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...inputFiles(directory, file));
    else
      result.push([
        file.split(path.sep).join("/"),
        sha(fs.readFileSync(path.join(directory, file))),
      ]);
  }
  return result;
};
const fingerprint = (source) =>
  sha(JSON.stringify(inputFiles(source).sort(([a], [b]) => a.localeCompare(b))));
const packageFiles = (directory) =>
  [
    ...new Set(
      (
        execFileSync("git", ["ls-files", "-z"], { cwd: directory, encoding: "utf8" }) +
        execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
          cwd: directory,
          encoding: "utf8",
        })
      )
        .split("\0")
        .filter(Boolean),
    ),
  ]
    .filter(
      (file) =>
        fs.existsSync(path.join(directory, file)) &&
        fs.statSync(path.join(directory, file)).isFile(),
    )
    .sort();
const packageFingerprint = (directory, files) =>
  sha(
    JSON.stringify(files.map((file) => [file, sha(fs.readFileSync(path.join(directory, file)))])),
  );

async function main() {
  const candidateRevision = git("rev-parse", "HEAD").trim();
  const candidateDirty = Boolean(git("status", "--porcelain=v1").trim());
  const sourceBeforeCopy = fingerprint(root);
  fs.mkdirSync(destination, { recursive: true });
  const candidate = path.join(destination, "javascript");
  assert(!fs.existsSync(candidate), "Use a fresh output directory");
  fs.mkdirSync(candidate);
  const files = [
    ...new Set(
      (git("ls-files", "-z") + git("ls-files", "--others", "--exclude-standard", "-z"))
        .split("\0")
        .filter(Boolean),
    ),
  ];
  for (const file of files) {
    const source = path.join(root, file);
    if (!fs.existsSync(source)) continue;
    const target = path.join(candidate, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.statSync(source).isDirectory())
      fs.cpSync(source, target, {
        recursive: true,
        filter: (file) => path.basename(file) !== ".git",
      });
    else fs.copyFileSync(source, target);
  }
  fs.symlinkSync(
    path.join(root, "node_modules"),
    path.join(candidate, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal(
    fingerprint(root),
    sourceBeforeCopy,
    "Working source changed while freezing the candidate",
  );
  assert.equal(
    fingerprint(candidate),
    sourceBeforeCopy,
    "Frozen candidate differs from the working source",
  );
  assert.equal(
    git("rev-parse", "HEAD").trim(),
    candidateRevision,
    "HEAD changed while freezing the candidate",
  );
  // The archived native implementation and frozen JS tree execute identical
  // benchmark bytes. Editing the development checkout cannot change either.
  const bytes = fs.readFileSync(path.join(root, driver));
  fs.copyFileSync(path.join(root, driver), path.join(candidate, driver));
  fs.copyFileSync(path.join(root, driver), path.join(baseline, driver));
  const modelBytes = fs.readFileSync(path.join(root, modelDriver));
  fs.copyFileSync(path.join(root, modelDriver), path.join(candidate, modelDriver));
  fs.copyFileSync(path.join(root, modelDriver), path.join(baseline, modelDriver));
  const sources = { native: baseline, javascript: candidate };
  const hashes = Object.fromEntries(
    Object.entries(sources).map(([name, source]) => [name, fingerprint(source)]),
  );
  const dependencyHash = sha(fs.readFileSync(path.join(root, "package-lock.json")));
  const packageSources = {},
    packageHashes = {},
    packageRevisions = {},
    packageInputs = {};
  for (const name of config.packages) {
    const source = path.join(root, "..", name);
    const target = path.join(destination, "packages", name);
    const files = packageFiles(source);
    const before = packageFingerprint(source, files);
    for (const file of files) {
      const output = path.join(target, file);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.copyFileSync(path.join(source, file), output);
    }
    assert.equal(
      packageFingerprint(source, packageFiles(source)),
      before,
      `${name} changed while freezing`,
    );
    assert.equal(packageFingerprint(target, files), before, `${name} snapshot differs`);
    if (fs.existsSync(path.join(source, "node_modules")))
      fs.symlinkSync(
        path.join(source, "node_modules"),
        path.join(target, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
    packageSources[name] = target;
    packageHashes[name] = before;
    packageInputs[name] = files;
    packageRevisions[name] = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: source,
      encoding: "utf8",
    }).trim();
  }
  const nativePath = path.join(
    path.dirname(require.resolve("@lumine-code/superstring")),
    "build",
    "Release",
    "superstring.node",
  );
  const nativeHash = sha(fs.readFileSync(nativePath));
  const reports = [];
  const order = [];
  for (let pair = 0; pair < repetitions; pair++)
    order.push(...(pair % 2 ? ["javascript", "native"] : ["native", "javascript"]));
  const electron = require("electron");
  for (const [index, label] of order.entries()) {
    const source = sources[label];
    const output = path.join(destination, `${label}-${index}.json`);
    const home = path.join(destination, "homes", `${label}-${index}`);
    fs.mkdirSync(home, { recursive: true });
    if (config.packages.length) {
      fs.mkdirSync(path.join(home, "packages"));
      for (const name of config.packages)
        fs.symlinkSync(
          packageSources[name],
          path.join(home, "packages", name),
          process.platform === "win32" ? "junction" : "dir",
        );
    }
    console.log(`${label}: process ${index + 1}/${order.length}`);
    const env = {
      ...process.env,
      LUMINE_HOME: home,
      LUMINE_RESOURCE_PATH: source,
      LUMINE_DOCUMENT_BENCH_CONFIG: JSON.stringify(config),
      LUMINE_DOCUMENT_BENCH_OUTPUT: output,
      LUMINE_TEST_PACKAGES: config.packages.join(" "),
    };
    delete env.CI;
    const log = fs.openSync(path.join(destination, `${label}-${index}.log`), "w");
    const child = spawn(
      electron,
      [
        "--no-sandbox",
        "--enable-logging",
        source,
        "-f",
        "--dev",
        "--test",
        path.join(source, driver),
      ],
      { cwd: source, env, windowsHide: true, stdio: ["ignore", log, log] },
    );
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      fs.closeSync(log);
    }
    if (code !== 0 || !fs.existsSync(output))
      throw new Error(
        `Benchmark ${label} exited ${code}; inspect ${path.basename(output, ".json")}.log`,
      );
    const report = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(report.driverHash, sha(bytes));
    assert.equal(
      report.superstringLoaded,
      label === "native",
      "Wrong document implementation was measured",
    );
    const modelFile = path.join(destination, `${label}-${index}-model.json`);
    execFileSync(
      process.execPath,
      [
        "--expose-gc",
        path.join(source, modelDriver),
        "--source",
        source,
        "--units",
        "1000000,8000000",
        "--filter",
        option("model-filter", "^(autocomplete|document|search)/"),
        "--samples",
        String(Math.max(7, config.samples)),
        "--warmups",
        String(config.warmups),
        "--output",
        modelFile,
      ],
      { cwd: source, env, stdio: ["ignore", "ignore", "pipe"] },
    );
    const model = JSON.parse(fs.readFileSync(modelFile, "utf8"));
    assert.equal(model.environment.documentBackend, label);
    assert.equal(model.benchmarkSha256, sha(modelBytes));
    if (reports.length) assert.equal(model.checksum, reports[0].model.checksum);
    model.environment.source = label;
    if (model.environment.binding) model.environment.binding = "superstring.node";
    reports.push({ label, ...report, model });
    for (const [name, source] of Object.entries(sources))
      assert.equal(fingerprint(source), hashes[name], `${name} source changed`);
    assert.equal(
      sha(fs.readFileSync(path.join(root, "package-lock.json"))),
      dependencyHash,
      "Installed dependency definition changed",
    );
    assert.equal(sha(fs.readFileSync(nativePath)), nativeHash, "Native reference binary changed");
    for (const name of config.packages)
      assert.equal(
        packageFingerprint(packageSources[name], packageInputs[name]),
        packageHashes[name],
        `${name} snapshot changed`,
      );
  }
  const summary = [];
  const median = (values) => {
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  for (const first of reports[0].results) {
    const rows = reports.map((report) => ({
      label: report.label,
      result: report.results.find((result) => result.id === first.id),
    }));
    for (const { result } of rows) {
      for (const key of [
        "inputHash",
        "outputHash",
        "originalSyntax",
        "editedSyntax",
        "editedScreenLines",
      ])
        assert.equal(result[key], first[key], `Different ${key} for ${first.id}`);
    }
    for (const operation of Object.keys(first.metrics)) {
      const entry = { id: first.id, operation };
      for (const label of ["native", "javascript"])
        entry[label] = Object.fromEntries(
          Object.keys(first.metrics[operation]).map((metric) => [
            metric,
            median(
              rows
                .filter((row) => row.label === label)
                .map(({ result }) => result.metrics[operation][metric].median),
            ),
          ]),
        );
      entry.completeProcessMedians = Object.fromEntries(
        ["native", "javascript"].map((label) => [
          label,
          rows
            .filter((row) => row.label === label)
            .map(({ result }) => result.metrics[operation].complete.median),
        ]),
      );
      summary.push(entry);
    }
  }
  const modelSummary = reports[0].model.results.map((first) => {
    const entry = { id: first.id };
    for (const label of ["native", "javascript"]) {
      const values = reports
        .filter((report) => report.label === label)
        .map((report) => report.model.results.find((result) => result.id === first.id));
      entry[label] = {
        median: median(values.map((value) => value.medianMs)),
        processMedians: values.map((value) => value.medianMs),
        timerDelay: median(values.map((value) => value.timerDelay.medianMs)),
      };
    }
    return entry;
  });
  const result = {
    createdAt: new Date().toISOString(),
    baselineRevision,
    candidateRevision,
    candidateDirty,
    config,
    repetitions,
    sourceHashes: hashes,
    dependencyHash,
    packageHashes,
    packageRevisions,
    packagesFrozen: true,
    nativeHash,
    driverHash: sha(bytes),
    modelDriverHash: sha(modelBytes),
    summary,
    modelSummary,
    reports,
  };
  fs.writeFileSync(path.join(destination, "report.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Report: ${path.join(destination, "report.json")}`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
