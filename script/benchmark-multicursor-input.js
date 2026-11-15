// Isolated actual-worker input benchmark. No source or configuration overrides.
// LUMINE_PERF_QUIET_WINDOW=1 node script/benchmark-multicursor-input.js
//   --case python-500-independent-128 --samples 5 --warmups 1 --output DIRECTORY
// --source DIRECTORY --revision SHA runs an exact archived source tree while
// retaining the same benchmark/fixtures. --package-root DIRECTORY optionally
// links its language-python and language-ipython packages into the isolated home.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync, execFileSync } = require("node:child_process");

if (process.env.LUMINE_PERF_QUIET_WINDOW !== "1")
  throw new Error(
    "Set LUMINE_PERF_QUIET_WINDOW=1 only after local tests and other benchmarks have stopped",
  );
const root = path.resolve(__dirname, "..");
const options = {
  source: root,
  cases: [],
  samples: 3,
  warmups: 1,
  mode: "newline",
  cycles: 1,
  interval: 0,
  capture: 0,
};
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index],
    value = process.argv[index + 1];
  if (
    !value ||
    ![
      "--source",
      "--revision",
      "--case",
      "--samples",
      "--warmups",
      "--output",
      "--package-root",
      "--mode",
      "--cycles",
      "--interval",
      "--capture",
    ].includes(flag)
  )
    throw new Error(`Invalid benchmark option ${flag}`);
  if (flag === "--case") options.cases.push(value);
  else options[flag.slice(2)] = value;
}
for (const name of ["samples", "warmups", "cycles", "interval", "capture"]) {
  options[name] = Number(options[name]);
  if (
    !Number.isSafeInteger(options[name]) ||
    options[name] < (["samples", "cycles"].includes(name) ? 1 : 0)
  )
    throw new Error(`Invalid ${name}`);
}
if (!["newline", "burst"].includes(options.mode)) throw new Error("Invalid --mode");
if (![0, 1].includes(options.capture)) throw new Error("--capture must be 0 or 1");
if (options.cycles > 100) throw new Error("--cycles exceeds the bounded burst size");
const source = path.resolve(options.source);
const checkout = fs.existsSync(path.join(source, ".git"));
const revision = checkout
  ? execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim()
  : options.revision;
if (!revision || (options.revision && options.revision !== revision))
  throw new Error(
    "An archive requires its explicit exact revision; a checkout must match --revision",
  );
if (
  checkout &&
  execFileSync("git", ["status", "--porcelain"], { cwd: source, encoding: "utf8" }).trim()
)
  throw new Error("Measured source must be a clean checkout");
const directory = path.resolve(
  options.output ??
    path.join(
      root,
      ".dev",
      "multicursor-input",
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`,
    ),
);
if (fs.existsSync(directory) && fs.readdirSync(directory).length)
  throw new Error("Choose a fresh result directory");
fs.mkdirSync(directory, { recursive: true });
const home = path.join(directory, "home");
fs.mkdirSync(path.join(home, "packages"), { recursive: true });
if (options["package-root"]) {
  for (const name of ["language-python", "language-ipython"]) {
    const target = path.resolve(options["package-root"], name);
    const manifest = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
    if (manifest.name !== name) throw new Error(`Unexpected package ${target}`);
    const link = path.join(home, "packages", name);
    if (fs.existsSync(link)) throw new Error("Choose a fresh isolated home");
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  }
}
const config = {
  sourcePath: source,
  sourceRevision: revision,
  samples: options.samples,
  warmups: options.warmups,
  mode: options.mode,
  cycles: options.cycles,
  intervalMs: options.interval,
  capture: Boolean(options.capture),
  captureStandalone: Boolean(options.capture),
  benchmarkPath: path.join(root, "benchmark", "multicursor-input-benchmark-spec.js"),
  output: path.join(directory, "result.json"),
};
if (options.cases.length) config.caseIds = options.cases;
fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify(config, null, 2));
const env = {
  ...process.env,
  LUMINE_HOME: home,
  LUMINE_RESOURCE_PATH: source,
  LUMINE_SYNTAX_EXECUTION: "worker",
  LUMINE_TEST_PACKAGES: "language-python language-ipython",
  LUMINE_MULTICURSOR_INPUT_BENCH_CONFIG: JSON.stringify(config),
};
delete env.CI;
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const electron = require(path.join(source, "node_modules", "electron"));
const child = spawn(
  electron,
  [
    "--no-sandbox",
    "--enable-logging",
    options.capture ? path.join(root, "benchmark", "multicursor-input-main.js") : source,
    "-f",
    "--dev",
    ...(options.capture ? [] : ["--test", config.benchmarkPath]),
    "--user-data-dir",
    path.join(home, "electronUserData"),
  ],
  { cwd: source, env, windowsHide: true, stdio: "inherit" },
);
const watchdog = setTimeout(
  () => {
    console.error("Multicursor benchmark exceeded its process deadline");
    if (process.platform === "win32")
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    else child.kill("SIGKILL");
  },
  25 * 60 * 1000,
);
child.on("error", (error) => {
  clearTimeout(watchdog);
  throw error;
});
child.on("exit", (code) => {
  clearTimeout(watchdog);
  if (
    checkout &&
    (execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim() !==
      revision ||
      execFileSync("git", ["status", "--porcelain"], { cwd: source, encoding: "utf8" }).trim())
  )
    throw new Error("Source checkout changed during measurement");
  console.log(`Multicursor benchmark report: ${config.output}`);
  process.exitCode = code ?? 1;
});
