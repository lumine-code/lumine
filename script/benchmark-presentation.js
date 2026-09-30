// A real, visible Electron window. Unlike a renderer-only/rAF benchmark, this
// measures sendInputEvent -> subscription-observed composited frame. It does
// not measure physical monitor scanout. No DevTools or offscreen rendering.
//   node script/benchmark-presentation.js --samples 100 --output <directory>
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const samples = Number(option("samples", 100));
const executable = path.resolve(option("electron", require("electron")));
if (!Number.isInteger(samples) || samples < 1) throw new Error("--samples must be positive");
if (15 * (samples + 3) >= 60000) throw new Error("--samples exceeds the revision marker range");
const output = path.resolve(
  option(
    "output",
    path.join(
      root,
      "..",
      ".dev",
      "benchmarks",
      "editor-presentation",
      new Date().toISOString().replace(/[:.]/g, "-"),
    ),
  ),
);
fs.mkdirSync(output, { recursive: true });
if (
  fs.existsSync(path.join(output, "results.json")) ||
  fs.existsSync(path.join(output, "electron.log"))
)
  throw new Error("--output already contains a presentation run; choose a new directory");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-presentation-"));
fs.mkdirSync(path.join(home, "electronUserData"));
fs.mkdirSync(path.join(home, "packages"));
// Match the workspace's source packages without touching the user's home.
const packagePaths = [];
for (const name of [
  "language-text",
  "language-javascript",
  "language-html",
  "language-vue",
  "language-ipython",
  "language-python",
  "language-css",
  "language-shellscript",
  "language-sql",
  "language-gfm",
  "language-json",
]) {
  const source = path.join(root, "..", name);
  if (fs.existsSync(path.join(source, "package.json"))) {
    packagePaths.push(source);
    fs.symlinkSync(
      source,
      path.join(home, "packages", name),
      process.platform === "win32" ? "junction" : "dir",
    );
  }
}
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function filesBelow(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(file) : [file];
  });
}
const addonRoot = path.dirname(require.resolve("@lumine-code/superstring/package.json"));
const hashedFiles = [
  ...[
    "package.json",
    "package-lock.json",
    "src/text-editor-component.js",
    "src/tree-sitter-language-mode.js",
    "src/display-layer.js",
    "src/text-buffer.js",
    "benchmark/presentation-main.js",
    "benchmark/presentation-renderer.js",
    "benchmark/presentation-observer.js",
    "script/benchmark-presentation.js",
  ].map((file) => path.join(root, file)),
  path.join(addonRoot, "package.json"),
  ...filesBelow(path.join(addonRoot, "build")).filter((file) => file.endsWith(".node")),
  ...packagePaths.flatMap((source) => [
    path.join(source, "package.json"),
    ...filesBelow(path.join(source, "grammars")),
    ...(fs.existsSync(path.join(source, "lib")) ? filesBelow(path.join(source, "lib")) : []),
  ]),
];
const config = {
  samples,
  warmups: 3,
  case: option("case", null),
  output,
  home,
  root,
  executable,
  fileSha256: Object.fromEntries(hashedFiles.map((file) => [file, sha256(file)])),
  editorSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  workingTree: execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }).trim(),
};
const log = fs.openSync(path.join(output, "electron.log"), "w");
const child = spawn(
  executable,
  [
    "--no-sandbox",
    path.join(root, "benchmark", "presentation-main.js"),
    "--dev",
    "--clear-window-state",
  ],
  {
    cwd: root,
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      LUMINE_HOME: home,
      LUMINE_RESOURCE_PATH: root,
      LUMINE_PRESENTATION_CONFIG: JSON.stringify(config),
    },
  },
);
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  fs.closeSync(log);
  const resultPath = path.join(output, "results.json");
  if (!fs.existsSync(resultPath)) {
    console.error(`No result; inspect ${path.join(output, "electron.log")}`);
    process.exitCode = code || 1;
    return;
  }
  const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  console.log(
    JSON.stringify(
      {
        resultPath,
        status: result.status,
        cases: result.cases?.map(({ name, presentation, failures }) => ({
          name,
          ...presentation,
          failures,
        })),
      },
      null,
      2,
    ),
  );
  process.exitCode = code === 0 && result.status === "complete" ? 0 : 1;
});
