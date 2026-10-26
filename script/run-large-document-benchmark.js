// Runs the benchmark in a fresh normal Lumine window, never the spec renderer.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const iconv = require("iconv-lite");

const ROOT = path.resolve(__dirname, "..");
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const HELP = `Usage: node script/run-large-document-benchmark.js [options]
  --input PATH          Optional external file; read only, never saved
  --output DIRECTORY    Fresh result directory (default: .dev/large-document-benchmark/<run>)
  --link DIRECTORY      Link a package checkout into the isolated profile; repeatable
  --packages NAMES      Comma-separated additional package names to activate
  --samples NUMBER      Enter commands at each of start/middle/end (default: 30)
  --interval-ms NUMBER  Absolute input spacing (default: 33.333)
  --rows NUMBER         Generated smoke rows when --input is absent (default: 300100, ~0.6 MiB)
  --sparse PATTERN      Sparse regex (default: generated fixture sentinel)
  --sparse-flags FLAGS  Sparse regex flags (default: g)
  --dense PATTERN       Dense regex (default: .)
  --dense-flags FLAGS   Dense regex flags (default: gu)
  --timeout-ms NUMBER   Overall renderer deadline (default: 600000)
  --plan                Validate arguments and report the sanitized plan without launching
  --help                Show this help

Only results.json is intended for sharing. The isolated profile is local runtime state.
See benchmark/large-document-benchmark.md and docs/large-document-editing.md.
`;

function parse(argv) {
  const options = { link: [] };
  const known = new Set([
    "input",
    "output",
    "link",
    "packages",
    "samples",
    "interval-ms",
    "rows",
    "sparse",
    "sparse-flags",
    "dense",
    "dense-flags",
    "timeout-ms",
  ]);
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index].replace(/^--/, "");
    if (["help", "plan"].includes(key)) {
      options[key] = true;
      continue;
    }
    if (!known.has(key) || !argv[index + 1] || argv[index + 1].startsWith("--"))
      throw new Error("Invalid or incomplete benchmark option");
    const value = argv[++index];
    if (key === "link") options.link.push(path.resolve(value));
    else options[key] = value;
  }
  return options;
}

async function digestFile(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function digestInput(file, encoding) {
  const bytes = crypto.createHash("sha256"),
    text = crypto.createHash("sha256");
  const decoder = iconv.getDecoder(encoding, { stripBOM: false });
  for await (const chunk of fs.createReadStream(file)) {
    bytes.update(chunk);
    text.update(Buffer.from(decoder.write(chunk), "utf16le"));
  }
  text.update(Buffer.from(decoder.end() || "", "utf16le"));
  return { bytesSha256: bytes.digest("hex"), decodedUtf16leSha256: text.digest("hex") };
}

async function fingerprint(directory, name) {
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  const roots = [
    "package.json",
    "package-lock.json",
    "src",
    "lib",
    "static",
    "styles",
    "keymaps",
    "menus",
    "settings",
    "snippets",
    "grammars",
    "queries",
    "api",
  ];
  if (directory === ROOT)
    roots.push(
      "benchmark/large-document-benchmark-spec.js",
      "script/run-large-document-benchmark.js",
    );
  const files = [
    ...new Set(
      git("ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...roots)
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
  const hash = crypto.createHash("sha256");
  let count = 0;
  for (const file of files) {
    const absolute = path.resolve(directory, file);
    if (!absolute.startsWith(path.resolve(directory) + path.sep))
      throw new Error("Invalid source inventory path");
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    hash.update(file.replaceAll("\\", "/") + "\0" + (await digestFile(absolute)) + "\n");
    count++;
  }
  return {
    name,
    revision: git("rev-parse", "HEAD"),
    dirty: Boolean(git("status", "--porcelain", "--untracked-files=normal")),
    sourceSha256: hash.digest("hex"),
    fileCount: count,
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function connect(port, timeoutMs) {
  const deadline = Date.now() + 90000;
  let target;
  while (Date.now() < deadline) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`)
      .then((response) => response.json())
      .catch(() => []);
    target = targets.find(
      (item) =>
        item.type === "page" &&
        item.url.includes("index.html") &&
        !item.url.startsWith("devtools://"),
    );
    if (target) break;
    await sleep(100);
  }
  if (!target) throw new Error("BENCHMARK_WINDOW_START_TIMEOUT");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("BENCHMARK_PROTOCOL_CONNECTION_FAILED")),
      { once: true },
    );
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data),
      request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error("BENCHMARK_PROTOCOL_REQUEST_FAILED"));
    else request.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("BENCHMARK_PROTOCOL_CLOSED"));
    }
    pending.clear();
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("BENCHMARK_PROTOCOL_TIMEOUT"));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return {
    targetId: target.id,
    send,
    close: () => socket.close(),
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (result.exceptionDetails) {
        const details =
          result.exceptionDetails.exception?.description || result.exceptionDetails.text;
        const code = /\b[A-Z][A-Z_]{5,}\b/.exec(details)?.[0] || "BENCHMARK_RENDERER_FAILED";
        throw Object.assign(new Error(code), { code });
      }
      return result.result.value;
    },
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (options.help) {
    console.log(HELP);
    return;
  }
  const input = options.input
    ? path.resolve(options.input)
    : process.env.LUMINE_LARGE_DOCUMENT_BENCHMARK_FILE;
  const config = {
    inputFile: input ? path.resolve(input) : undefined,
    inputCount: Number(options.samples ?? 30),
    intervalMs: Number(options["interval-ms"] ?? 1000 / 30),
    generatedRows: Number(options.rows ?? 300100),
    packages: (options.packages || "").split(",").filter(Boolean),
    requireProduction: true,
    sparse: {
      name: "sparse",
      source: options.sparse ?? "__LUMINE_LARGE_DOCUMENT_BENCHMARK__",
      flags: options["sparse-flags"] || "g",
    },
    dense: { name: "dense", source: options.dense ?? ".", flags: options["dense-flags"] || "gu" },
  };
  for (const key of ["inputCount", "intervalMs", "generatedRows"])
    if (!Number.isFinite(config[key]) || config[key] < 0)
      throw new Error("INVALID_BENCHMARK_CONFIGURATION");
  if (
    !Number.isInteger(config.inputCount) ||
    config.inputCount < 1 ||
    config.inputCount > 1000 ||
    !Number.isInteger(config.generatedRows) ||
    config.generatedRows < 1 ||
    config.generatedRows > 1000000
  )
    throw new Error("INVALID_BENCHMARK_CONFIGURATION");
  const timeoutMs = Number(options["timeout-ms"] ?? 600000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000)
    throw new Error("INVALID_BENCHMARK_TIMEOUT");
  for (const descriptor of [config.sparse, config.dense].filter(Boolean))
    new RegExp(descriptor.source, descriptor.flags);
  const links = options.link.map((directory) => ({
    directory,
    name: JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")).name,
  }));
  if (new Set(links.map((item) => item.name)).size !== links.length)
    throw new Error("DUPLICATE_LINKED_PACKAGE_NAME");
  const plan = {
    input: config.inputFile ? "external-read-only" : "generated-smoke",
    samplesPerLocation: config.inputCount,
    inputIntervalMs: config.intervalMs,
    generatedRows: config.inputFile ? null : config.generatedRows,
    linkedPackages: links.map((item) => item.name),
    activatedPackages: config.packages,
    rendering: "normal application, real RAF, isolated profile, CI unset",
    inputIsNeverSaved: true,
  };
  if (options.plan) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  const output = path.resolve(
    options.output ||
      path.join(
        ROOT,
        ".dev",
        "large-document-benchmark",
        new Date().toISOString().replace(/[:.]/g, "-") + "-" + crypto.randomUUID().slice(0, 8),
      ),
  );
  fs.mkdirSync(output, { recursive: true });
  const resultFile = path.join(output, "results.json");
  if (fs.existsSync(resultFile)) throw new Error("BENCHMARK_RESULT_ALREADY_EXISTS");
  const home = path.join(output, "profile");
  if (fs.existsSync(home)) throw new Error("BENCHMARK_PROFILE_MUST_BE_FRESH");
  fs.mkdirSync(path.join(home, "electronUserData"), { recursive: true });
  fs.mkdirSync(path.join(home, "packages"), { recursive: true });
  for (const link of links) {
    const name = link.name.replace(/^@[^/]+\//, "");
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error("INVALID_LINKED_PACKAGE_NAME");
    fs.symlinkSync(
      link.directory,
      path.join(home, "packages", name),
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify(
      {
        "*": {
          core: {
            restorePreviousState: "no",
            openEmptyEditorOnStart: false,
            warnOnLargeFileLimit: 2048,
          },
          editor: { softWrap: false, largeFileOptimizations: true },
          about: { showOnStartup: false },
        },
      },
      null,
      2,
    ),
  );
  const sourceLocations = [{ directory: ROOT, name: "lumine" }, ...links];
  const sources = [];
  for (const source of sourceLocations)
    sources.push(await fingerprint(source.directory, source.name));
  const inputBefore = config.inputFile ? fs.statSync(config.inputFile) : null;
  const port = await freePort();
  const env = {
    ...process.env,
    LUMINE_HOME: home,
    LUMINE_RESOURCE_PATH: ROOT,
    LUMINE_DISABLE_WINDOW_STATE_PERSISTENCE: "1",
    LUMINE_DISABLE_URI_HANDLER_REGISTRATION: "1",
    LUMINE_DEV_MODE: "0",
  };
  delete env.CI;
  delete env.ELECTRON_RUN_AS_NODE;
  const launchedAt = performance.now();
  const child = spawn(
    require("electron"),
    [
      "--no-sandbox",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      `--remote-debugging-port=${port}`,
      ROOT,
      "--clear-window-state",
    ],
    { cwd: ROOT, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  // App logs may contain local paths or document text. Do not persist or include
  // them in the shareable report; failures use bounded symbolic error codes.
  child.stdout.resume();
  child.stderr.resume();
  let exited = false,
    client;
  const childExit = new Promise((resolve) => {
    child.once("exit", () => {
      exited = true;
      resolve();
    });
    child.once("error", resolve);
  });
  const report = {
    version: 1,
    status: "running",
    plan,
    sources,
    host: { platform: process.platform, arch: process.arch, cpuCount: os.cpus().length },
  };
  try {
    client = await connect(port, timeoutMs);
    const startupDeadline = Date.now() + 90000;
    while (
      !(await client.evaluate(
        "Boolean(globalThis.lumine?.workspace && lumine.packages.getActivePackages().length > 0)",
      ))
    ) {
      if (Date.now() >= startupDeadline) throw new Error("BENCHMARK_APPLICATION_START_TIMEOUT");
      await sleep(100);
    }
    report.applicationReadyMs = performance.now() - launchedAt;
    try {
      const { windowId } = await client.send("Browser.getWindowForTarget", {
        targetId: client.targetId,
      });
      await client.send("Browser.setWindowBounds", {
        windowId,
        bounds: { width: 1280, height: 900, windowState: "normal" },
      });
      report.nativeWindowSizing = true;
    } catch {
      report.nativeWindowSizing = false;
    }
    report.measurements = await client.evaluate(
      `require(${JSON.stringify(path.join(ROOT, "benchmark", "large-document-benchmark-spec.js"))}).runBenchmark(${JSON.stringify(config)})`,
    );
    if (report.measurements.status !== "complete")
      throw Object.assign(new Error("BENCHMARK_RENDERER_VALIDATION_FAILED"), {
        code: report.measurements.failure?.code,
      });
    if (config.inputFile) {
      const digest = await digestInput(config.inputFile, report.measurements.settings.encoding);
      const after = fs.statSync(config.inputFile);
      report.input = {
        bytes: inputBefore.size,
        sha256: digest.bytesSha256,
        statUnchanged: inputBefore.size === after.size && inputBefore.mtimeMs === after.mtimeMs,
        exactDecodedTextUnchanged:
          digest.decodedUtf16leSha256 === report.measurements.input.snapshotUtf16leSha256,
      };
      if (!report.input.statUnchanged || !report.input.exactDecodedTextUnchanged)
        throw new Error("BENCHMARK_INPUT_CHANGED");
    }
    const afterSources = [];
    for (const source of sourceLocations)
      afterSources.push(await fingerprint(source.directory, source.name));
    report.sourceStable = sources.every(
      (source, index) =>
        source.sourceSha256 === afterSources[index].sourceSha256 &&
        source.revision === afterSources[index].revision,
    );
    if (!report.sourceStable) throw new Error("BENCHMARK_SOURCES_CHANGED_DURING_RUN");
    report.status = "complete";
  } catch (error) {
    report.status = "failed";
    report.failure = {
      code: error.code || (/^[A-Z_]+$/.test(error.message) ? error.message : "BENCHMARK_FAILED"),
    };
    process.exitCode = 1;
  } finally {
    if (client) {
      await client.evaluate("setTimeout(() => lumine.window.close(), 0); true").catch(() => {});
      client.close();
    }
    await Promise.race([childExit, sleep(5000)]);
    if (!exited) child.kill();
    fs.writeFileSync(resultFile, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(`Benchmark ${report.status}; results: ${resultFile}`);
}

if (require.main === module)
  main().catch((error) => {
    console.error(
      /^[A-Z_]+$/.test(error.message)
        ? error.message
        : "Benchmark configuration or startup failed; check the supplied options.",
    );
    process.exitCode = 1;
  });
module.exports = { main, parse, digestInput, fingerprint };
