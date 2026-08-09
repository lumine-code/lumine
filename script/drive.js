// Drives a Lumine window from the terminal over the Chrome DevTools Protocol —
// the same protocol DevTools speaks, which Electron exposes with
// `--remote-debugging-port`. It exists for the work specs cannot do: watching a
// real window behave over time. The spec runner freezes `setTimeout`, so a
// timing race (a viewport reported before a scroll lands, a panel that scrolls
// to the wrong row) is invisible there but reproducible here.
//
//   node script/drive.js launch ~/some-project
//   node script/drive.js benchmark --runs 5
//   node script/drive.js eval "lumine.workspace.getActivePaneItem().getTitle()"
//   node script/drive.js console --ms 3000
//   node script/drive.js eval -f repro.js   # a whole scripted repro, instrumented
//   node script/drive.js reload             # after editing package source
//   node script/drive.js quit
//
// `--throttle <n>` slows the renderer's CPU for the life of one connection. It
// shifts the ratio between CPU work and anything of fixed duration — a timer, a
// cross-frame message hop — so it exposes some races, but NOT the ones where
// both sides scale with it. Measured against a known one (pdf-view reporting a
// viewport before its scroll had landed): still hidden at 8x and at 20x, because
// the host's rAF-driven repaint slows in step with the iframe's messages. For
// that class, instrument instead — `eval -f` a script that wraps the functions
// involved and returns a log of what ran in which order.
//
// `launch` runs an ISOLATED instance: it points `LUMINE_HOME` at a scratch
// directory, and since the single-instance socket secret lives under
// `$LUMINE_HOME/storage` (see src/lumine-application.js), a scratch home can
// never hand its paths to the editor you are working in. `--link` symlinks a
// package checkout into that home so the instance loads the code you are
// editing.
//
// Everything here talks JSON-RPC over one WebSocket. Node's global `WebSocket`
// and `fetch` are used deliberately: this must stay dependency-free so it works
// in a checkout whose `node_modules` is mid-rebuild.

const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DEFAULT_PORT = Number(process.env.LUMINE_DRIVE_PORT || 9223);

// The window is usable once its packages have activated; `lumine-workspace` alone
// is in the DOM well before that.
const READY =
  "Boolean(window.lumine && lumine.packages && lumine.packages.getActivePackages().length > 0)";

const USAGE = `Usage: node script/drive.js <command> [options]

Commands:
  launch [paths...]      Start an isolated instance with CDP enabled, wait until ready
  benchmark [paths...]   Measure isolated cold/warm startup runs and quit each instance
  eval <expression>      Evaluate in the renderer, print the result as JSON
  eval -f <file>         Evaluate a file's contents instead
  dispatch <command>     Dispatch a Lumine command (--target <selector>)
  reload                 Reload the window, wait until its packages are back
  console                Stream console output, uncaught errors and rejections
  issues                 Stream DevTools issues — deprecations never reach the console
  shot <selector>        Screenshot one element, clipped to its rect
  drag <selector>        Drag the mouse across an element (or "drag x1 y1 x2 y2")
  move <x> <y>           Move the pointer there and leave it, no buttons held
  throttle <rate>        Hold renderer CPU throttling (--ms, default 30000)
  targets                List the debuggable windows
  quit                   Close the driven window

Options:
  --port <n>             CDP port (default ${DEFAULT_PORT}, or $LUMINE_DRIVE_PORT)
  --window <n>           Which window to drive when several are open (default 0)
  --home <dir>           launch: scratch LUMINE_HOME (default <tmp>/lumine-drive-<port>)
  --link <dir>           launch: symlink a package checkout into <home>/packages, repeatable
  --fresh                launch: also pass --clear-window-state
  --no-dev               launch: omit --dev
  --runs <n>             benchmark: number of launches (default 5)
  --executable <file>    benchmark: launch a packaged Lumine executable
  --json                 benchmark: emit the full samples as JSON
  --ms <n>               console/issues: how long to stream, 0 to stream until killed (default 5000)
  --out <file>           shot: output path (default drive-shot.png)
  --scale <n>            shot: capture scale (default 1)
  --index <n>            shot/drag: which match to use when the selector hits several
  --steps <n>            drag: how many moves between press and release (default 8)
  --raw                  eval: print strings unquoted
  --throttle <n>         any command: throttle the renderer while it runs (8 = eight times slower)
`;

const BOOLEAN = new Set(["--fresh", "--no-dev", "--raw", "--json", "--help", "-h"]);

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    let value = true;
    const equals = arg.indexOf("=");
    if (equals !== -1) {
      value = arg.slice(equals + 1);
      arg = arg.slice(0, equals);
    } else if (!BOOLEAN.has(arg) && argv[i + 1] !== undefined && !argv[i + 1].startsWith("-")) {
      value = argv[++i];
    }
    const name = arg.replace(/^-+/, "");
    // Repeated options (`--link a --link b`) collect instead of overwriting.
    options[name] = options[name] === undefined ? value : [].concat(options[name], value);
  }
  return { positional, options };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  console.error(`drive: ${message}`);
  process.exit(1);
}

function homeForPort(port) {
  return path.join(os.tmpdir(), `lumine-drive-${port}`);
}

function prepareIsolatedHome(home) {
  fs.mkdirSync(path.join(home, "packages"), { recursive: true });
  // lumine-paths only redirects Electron's userData when this directory already
  // exists. Without it, a driven instance falls back to Electron's default
  // profile and can contend with the editor being used to run the benchmark.
  fs.mkdirSync(path.join(home, "electronUserData"), { recursive: true });
}

async function requireAvailablePort(port) {
  try {
    await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(resolve));
    });
  } catch (error) {
    if (error.code === "EADDRINUSE") {
      fail(`debugging port ${port} is already in use`);
    }
    throw error;
  }
}

// A page target per window — plus one for DevTools itself when it is open, which
// is why the URL is matched rather than the title.
async function listWindows(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await response.json();
  return targets.filter(
    (target) =>
      target.type === "page" &&
      target.url.includes("index.html") &&
      !target.url.startsWith("devtools://"),
  );
}

async function connect({ port, window = 0, timeout = 20000 }) {
  const deadline = Date.now() + timeout;
  let windows = [];
  while (Date.now() < deadline) {
    windows = await listWindows(port).catch(() => []);
    if (windows.length > window) break;
    await sleep(400);
  }
  if (windows.length <= window) {
    fail(
      `no debuggable Lumine window ${window} on port ${port} — ` +
        `start one with: node script/drive.js launch`,
    );
  }
  if (windows.length > 1) {
    console.error(`drive: ${windows.length} windows open, driving window ${window}`);
  }

  const socket = new WebSocket(windows[window].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("could not open the CDP socket")), {
      once: true,
    });
  });

  let lastId = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const promise = pending.get(message.id);
      if (!promise) return;
      pending.delete(message.id);
      if (message.error) promise.reject(new Error(JSON.stringify(message.error)));
      else promise.resolve(message.result);
    } else if (listeners.has(message.method)) {
      listeners.get(message.method)(message.params);
    }
  });

  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++lastId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  return {
    send,
    on: (method, handler) => listeners.set(method, handler),
    close: () => socket.close(),
    // `awaitPromise` so an async expression resolves before returning, and
    // `returnByValue` so the result crosses the socket as JSON instead of a
    // remote-object handle.
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (result.exceptionDetails) {
        const { exception, text } = result.exceptionDetails;
        throw new Error(exception?.description || exception?.value || text);
      }
      return result.result.value;
    },
  };
}

// CPU throttling lasts only as long as the session that asked for it: Chromium
// restores emulation state when the client detaches, so setting a rate and
// disconnecting measurably does nothing. Every command therefore applies
// `--throttle` on its OWN connection, which is what makes
// `eval --throttle 8 '<repro>'` the useful form — the whole expression runs slow.
async function clientFor(options, extra = {}) {
  const client = await connect({
    port: Number(options.port || DEFAULT_PORT),
    window: Number(options.window || 0),
    ...extra,
  });
  const rate = Number(options.throttle || 0);
  if (rate >= 1) await client.send("Emulation.setCPUThrottlingRate", { rate });
  return client;
}

async function waitForReady(client, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await client.evaluate(READY).catch(() => false)) return;
    await sleep(400);
  }
  fail("the window came up but its packages never activated");
}

// `fs.symlinkSync` needs the "junction" type for directories on Windows —
// a plain "dir" link there requires elevation, a junction does not.
function linkPackage(home, source) {
  const from = path.resolve(source);
  if (!fs.existsSync(path.join(from, "package.json"))) {
    fail(`--link ${source} is not a package directory`);
  }
  const to = path.join(home, "packages", path.basename(from));
  if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
  fs.symlinkSync(from, to, process.platform === "win32" ? "junction" : "dir");
  return to;
}

async function launch({ positional, options }) {
  const port = Number(options.port || DEFAULT_PORT);
  const home = path.resolve(options.home || homeForPort(port));
  await requireAvailablePort(port);
  prepareIsolatedHome(home);
  const linked = [].concat(options.link || []).map((source) => linkPackage(home, source));

  const argv = ["--no-sandbox", "--enable-logging", `--remote-debugging-port=${port}`, ROOT];
  if (!options["no-dev"]) argv.push("--dev");
  if (options.fresh) argv.push("--clear-window-state");
  argv.push(...positional.map((item) => path.resolve(item)));

  const logPath = path.join(home, "drive.log");
  const log = fs.openSync(logPath, "a");
  const child = spawn(require("electron"), argv, {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, LUMINE_HOME: home },
  });
  child.unref();
  fs.writeFileSync(path.join(home, "drive.pid"), String(child.pid));

  const client = await connect({ port, timeout: 90000 });
  await waitForReady(client);
  client.close();

  console.log(`port  ${port}`);
  console.log(`home  ${home}`);
  console.log(`log   ${logPath}`);
  console.log(`pid   ${child.pid}`);
  for (const link of linked) console.log(`link  ${link}`);
}

const STARTUP_STAGES = [
  {
    name: "mainRequire",
    start: "main-process:lumine-application:require:start",
    end: "main-process:lumine-application:require:end",
  },
  {
    name: "packageLoad",
    start: "window:environment:start-editor-window:load-packages",
    end: "window:environment:start-editor-window:load-packages:end",
  },
  {
    name: "deserialize",
    start: "window:environment:start-editor-window:deserialize-state",
    end: "window:environment:start-editor-window:activate-packages",
  },
  {
    name: "packageActivation",
    start: "window:environment:start-editor-window:activate-packages",
    end: "window:environment:start-editor-window:activate-packages:end",
  },
  {
    name: "editorStartup",
    start: "window:environment:start-editor-window:start",
    end: "window:environment:start-editor-window:end",
  },
  {
    name: "totalToEditorReady",
    start: "main-process:start",
    end: "window:environment:start-editor-window:end",
  },
];

function startupDurations(markers) {
  const times = new Map(markers.map(({ label, time }) => [label, time]));
  return Object.fromEntries(
    STARTUP_STAGES.map(({ name, start, end }) => {
      const startTime = times.get(start);
      const endTime = times.get(end);
      return [name, startTime == null || endTime == null ? null : endTime - startTime];
    }),
  );
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function summarizeStartup(samples) {
  return Object.fromEntries(
    ["wall", ...STARTUP_STAGES.map(({ name }) => name)].map((name) => {
      const values = samples.map((sample) => sample[name]).filter(Number.isFinite);
      if (values.length === 0) return [name, null];
      return [
        name,
        {
          median: median(values),
          min: Math.min(...values),
          max: Math.max(...values),
        },
      ];
    }),
  );
}

function summarizePackages(samples, timeKey) {
  const timesByPackage = new Map();
  for (const sample of samples) {
    for (const pack of sample.packages) {
      if (!Number.isFinite(pack[timeKey])) continue;
      if (!timesByPackage.has(pack.name)) timesByPackage.set(pack.name, []);
      timesByPackage.get(pack.name).push(pack[timeKey]);
    }
  }
  return [...timesByPackage]
    .map(([name, values]) => ({ name, median: median(values), max: Math.max(...values) }))
    .sort((a, b) => b.median - a.median || b.max - a.max || a.name.localeCompare(b.name));
}

function waitForChildExit(child, timeout = 20000) {
  if (child.exitCode != null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Lumine process ${child.pid} did not exit after the benchmark run`));
    }, timeout);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function benchmark({ positional, options }) {
  const runs = Number(options.runs || 5);
  if (!Number.isInteger(runs) || runs < 1 || runs > 50) {
    fail("--runs must be an integer from 1 through 50");
  }

  const port = Number(options.port || DEFAULT_PORT);
  const executable = options.executable ? path.resolve(options.executable) : require("electron");
  if (!fs.existsSync(executable)) fail(`executable does not exist: ${executable}`);
  const home = path.resolve(
    options.home || fs.mkdtempSync(path.join(os.tmpdir(), `lumine-benchmark-${port}-`)),
  );
  prepareIsolatedHome(home);
  const linked = [].concat(options.link || []).map((source) => linkPackage(home, source));
  const logPath = path.join(home, "benchmark.log");
  const samples = [];

  for (let run = 1; run <= runs; run++) {
    await requireAvailablePort(port);
    const argv = ["--no-sandbox", "--enable-logging", `--remote-debugging-port=${port}`];
    if (!options.executable) argv.push(ROOT);
    if (!options["no-dev"]) argv.push("--dev");
    if (options.fresh) argv.push("--clear-window-state");
    argv.push(...positional.map((item) => path.resolve(item)));

    const log = fs.openSync(logPath, "a");
    const started = performance.now();
    const env = { ...process.env, LUMINE_HOME: home };
    if (options.executable) {
      delete env.LUMINE_DEV_MODE;
      delete env.LUMINE_RESOURCE_PATH;
    }
    const child = spawn(executable, argv, {
      stdio: ["ignore", log, log],
      env,
    });
    child.once("exit", () => fs.closeSync(log));

    try {
      const client = await connect({ port, timeout: 90000 });
      await waitForReady(client);
      const snapshot = await client.evaluate(
        `lumine.window.whenLoaded().then(() => ({
          markers: lumine.window.getStartupMarkers(),
          packages: lumine.packages.getActivePackages().map(pack => ({
            name: pack.name,
            loadTime: pack.loadTime,
            initializeTime: pack.initializeTime,
            activateTime: pack.activateTime,
            settingsLoadTime: pack.settingsLoadTime,
            grammarLoadTime: pack.grammarLoadTime
          }))
        }))`,
      );
      const sample = {
        run,
        kind: run === 1 ? "cold" : "warm",
        wall: performance.now() - started,
        ...startupDurations(snapshot.markers),
        packages: snapshot.packages,
      };
      samples.push(sample);
      await client
        .evaluate(
          "setTimeout(() => lumine.commands.dispatch(lumine.views.getView(lumine.workspace), 'application:quit'), 50), 'quitting'",
        )
        .catch(() => {});
      client.close();
      const exitCode = await waitForChildExit(child);
      if (exitCode !== 0) throw new Error(`Lumine benchmark run ${run} exited with ${exitCode}`);
    } catch (error) {
      if (child.exitCode == null) child.kill();
      throw error;
    }
  }

  const warmSamples = samples.length > 1 ? samples.slice(1) : samples;
  const result = {
    home,
    log: logPath,
    executable,
    linked,
    samples,
    summary: summarizeStartup(warmSamples),
    packageLoad: summarizePackages(warmSamples, "loadTime"),
    packageActivation: summarizePackages(warmSamples, "activateTime"),
    packageSettings: summarizePackages(warmSamples, "settingsLoadTime"),
    packageGrammars: summarizePackages(warmSamples, "grammarLoadTime"),
  };
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`home  ${home}`);
  console.log(`log   ${logPath}`);
  for (const sample of samples) {
    console.log(
      `${String(sample.run).padStart(2)} ${sample.kind.padEnd(4)}  ` +
        `wall ${sample.wall.toFixed(1)}  total ${sample.totalToEditorReady?.toFixed(1)}  ` +
        `require ${sample.mainRequire?.toFixed(1)}  load ${sample.packageLoad?.toFixed(1)}  ` +
        `activate ${sample.packageActivation?.toFixed(1)} ms`,
    );
  }
  console.log("median/min/max (ms)");
  for (const [name, values] of Object.entries(result.summary)) {
    if (!values) continue;
    console.log(
      `  ${name.padEnd(20)} ${values.median.toFixed(1)} / ${values.min.toFixed(1)} / ${values.max.toFixed(1)}`,
    );
  }
  console.log("slowest warm package activation medians (ms)");
  for (const pack of result.packageActivation.slice(0, 10)) {
    console.log(`  ${pack.name.padEnd(28)} ${pack.median.toFixed(1)} (max ${pack.max.toFixed(1)})`);
  }
  console.log("slowest warm package load medians (ms)");
  for (const pack of result.packageLoad.slice(0, 10)) {
    console.log(`  ${pack.name.padEnd(28)} ${pack.median.toFixed(1)} (max ${pack.max.toFixed(1)})`);
  }
  console.log("slowest warm package settings medians (ms)");
  for (const pack of result.packageSettings.slice(0, 10)) {
    console.log(`  ${pack.name.padEnd(28)} ${pack.median.toFixed(1)} (max ${pack.max.toFixed(1)})`);
  }
  console.log("slowest warm package grammar medians (ms)");
  for (const pack of result.packageGrammars.slice(0, 10)) {
    console.log(`  ${pack.name.padEnd(28)} ${pack.median.toFixed(1)} (max ${pack.max.toFixed(1)})`);
  }
}

async function evaluate({ positional, options }) {
  const expression = options.f ? fs.readFileSync(options.f, "utf8") : positional.join(" ");
  if (!expression.trim()) fail("nothing to evaluate");
  const client = await clientFor(options);
  const value = await client.evaluate(expression).catch((error) => fail(error.message));
  client.close();
  if (value === undefined) return;
  console.log(options.raw && typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

async function dispatch({ positional, options }) {
  const command = positional[0];
  if (!command) fail("which command?");
  const target = options.target
    ? `document.querySelector(${JSON.stringify(options.target)})`
    : "lumine.views.getView(lumine.workspace)";
  const client = await clientFor(options);
  const dispatched = await client
    .evaluate(
      `(() => {
        const target = ${target};
        if (!target) return null;
        return lumine.commands.dispatch(target, ${JSON.stringify(command)});
      })()`,
    )
    .catch((error) => fail(error.message));
  client.close();
  if (dispatched === null) fail(`no element matched ${options.target}`);
  // `dispatch` returns false when nothing was listening — a silent no-op is the
  // most common reason a driven command "does nothing".
  console.log(dispatched ? `dispatched ${command}` : `${command} had no handler on the target`);
}

async function reload({ options }) {
  const client = await clientFor(options);
  // Reloading tears the socket down, so the call cannot be awaited — fire it
  // from a timer and reconnect to the new target.
  await client
    .evaluate("setTimeout(() => lumine.window.reload(), 50), 'reloading'")
    .catch(() => {});
  client.close();
  await sleep(2000);
  const next = await clientFor(options, { timeout: 60000 });
  await waitForReady(next);
  next.close();
  console.log("reloaded");
}

function describeArg(argument) {
  if (argument.value !== undefined) {
    return typeof argument.value === "string" ? argument.value : JSON.stringify(argument.value);
  }
  return argument.description || argument.preview?.description || argument.type;
}

async function tailConsole({ options }) {
  const client = await clientFor(options);
  const started = Date.now();
  const stamp = () => String(Date.now() - started).padStart(6, " ");
  await client.send("Runtime.enable");
  await client.send("Log.enable");
  client.on("Runtime.consoleAPICalled", ({ type, args }) => {
    console.log(`${stamp()}ms [${type}] ${args.map(describeArg).join(" ")}`);
  });
  client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    const detail = exceptionDetails.exception?.description || exceptionDetails.text;
    console.log(`${stamp()}ms [uncaught] ${detail}`);
  });
  client.on("Log.entryAdded", ({ entry }) => {
    console.log(`${stamp()}ms [${entry.level}] ${entry.text}`);
  });

  const ms = options.ms === undefined ? 5000 : Number(options.ms);
  if (ms > 0) {
    await sleep(ms);
    client.close();
  }
}

// Deprecations (and the rest of the DevTools "Issues" panel) never reach the
// console — Chromium files them on the Audits domain, so `console` is blind to
// them. Subscribing before `Audits.enable` matters: enabling replays the
// issues the page has already collected, so this also shows issues filed
// before the connection existed.
async function tailIssues({ options }) {
  const client = await clientFor(options);
  const started = Date.now();
  const stamp = () => String(Date.now() - started).padStart(6, " ");
  client.on("Audits.issueAdded", ({ issue }) => {
    console.log(`${stamp()}ms [${issue.code}] ${JSON.stringify(issue.details)}`);
  });
  await client.send("Audits.enable");

  const ms = options.ms === undefined ? 5000 : Number(options.ms);
  if (ms > 0) {
    await sleep(ms);
    client.close();
  }
}

async function shot({ positional, options }) {
  const selector = positional[0];
  if (!selector) fail("which selector?");
  const client = await clientFor(options);
  const rect = await client
    .evaluate(
      `(() => {
        const all = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
        const shown = all.filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        const el = shown[${Number(options.index || 0)}];
        if (!el) return { matched: all.length, shown: shown.length };
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, matched: all.length, shown: shown.length };
      })()`,
    )
    .catch((error) => fail(error.message));

  if (rect.width === undefined) {
    fail(`selector matched ${rect.matched} element(s), ${rect.shown} of them rendered`);
  }
  // A hidden duplicate reports a zero rect and a closed dock keeps its rows at
  // NEGATIVE x. A clip with a negative origin does not error — it silently
  // captures somewhere else, which looks like a real screenshot and is not.
  if (rect.x < 0 || rect.y < 0) {
    fail(
      `element is off-screen at (${Math.round(rect.x)}, ${Math.round(rect.y)}) — ` +
        `open the dock or pane that holds it first`,
    );
  }

  const { data } = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    clip: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      scale: Number(options.scale || 1),
    },
  });
  client.close();
  const out = path.resolve(options.out || "drive-shot.png");
  fs.writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`${out} (${Math.round(rect.width)}x${Math.round(rect.height)})`);
}

// Holding a rate for a while, for a repro driven by hand or by another command.
// It has to block: the rate dies with this connection (see clientFor).
async function throttle({ positional, options }) {
  const rate = Number(positional[0]);
  if (!Number.isFinite(rate) || rate < 1) fail("rate must be 1 or more (1 = no throttling)");
  const ms = options.ms === undefined ? 30000 : Number(options.ms);
  const client = await clientFor({ ...options, throttle: rate });
  console.log(
    `renderer throttled ${rate}x — ${ms > 0 ? `holding ${ms}ms` : "holding until killed"}`,
  );
  if (ms > 0) {
    await sleep(ms);
    client.close();
    console.log("throttling released");
  }
}

async function targets({ options }) {
  const port = Number(options.port || DEFAULT_PORT);
  const windows = await listWindows(port).catch(() => []);
  if (!windows.length) fail(`nothing debuggable on port ${port}`);
  windows.forEach((target, index) => console.log(`${index}  ${target.title}`));
}

async function quit({ options }) {
  const port = Number(options.port || DEFAULT_PORT);
  const windows = await listWindows(port).catch(() => []);
  if (windows.length) {
    const client = await clientFor(options);
    await client.evaluate("setTimeout(() => lumine.window.close(), 50), 'closing'").catch(() => {});
    client.close();
    console.log("closing");
    return;
  }
  // No window answering — fall back to the pid `launch` recorded, so a hung
  // instance can still be cleared without hunting for it in a task manager.
  const pidPath = path.join(path.resolve(options.home || homeForPort(port)), "drive.pid");
  if (!fs.existsSync(pidPath)) fail(`nothing to quit on port ${port}`);
  const pid = Number(fs.readFileSync(pidPath, "utf8"));
  try {
    process.kill(pid);
    console.log(`killed ${pid}`);
  } catch {
    fail(`no window on port ${port} and pid ${pid} is gone`);
  }
}

// Drags the mouse with TRUSTED events, which is the whole point: a MouseEvent
// dispatched from `eval` starts no native selection, opens no context menu and
// carries `isTrusted: false` wherever a listener checks. Anything that asks
// what the mouse actually does needs this rather than a synthetic dispatch.
// Takes either four numbers (client coordinates) or a selector, in which case
// it drags across the element's box from just inside one edge to the other.
async function drag({ positional, options }) {
  const client = await clientFor(options);
  let from;
  let to;

  if (positional.length >= 4 && positional.every((value) => !Number.isNaN(Number(value)))) {
    const [x1, y1, x2, y2] = positional.map(Number);
    from = { x: x1, y: y1 };
    to = { x: x2, y: y2 };
  } else {
    const selector = positional[0];
    if (!selector) fail("which selector, or which four coordinates?");
    const rect = await client
      .evaluate(
        // Same filter as `shot`, for the same reason: an editor keeps
        // off-screen measurement copies of its lines, and dragging across one
        // of those lands on whatever is at those coordinates instead.
        `(() => {
          const all = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
          const shown = all.filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0 &&
              r.right <= window.innerWidth && r.bottom <= window.innerHeight;
          });
          const el = shown[${Number(options.index || 0)}];
          if (!el) return { matched: all.length, shown: shown.length };
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height, matched: all.length, shown: shown.length };
        })()`,
      )
      .catch((error) => fail(error.message));
    if (rect.width === undefined) {
      fail(`selector matched ${rect.matched} element(s), ${rect.shown} of them on screen`);
    }
    if (rect.width < 4 || rect.height < 4) fail("that element is too small to drag across");
    const y = rect.y + rect.height / 2;
    from = { x: rect.x + 2, y };
    to = { x: rect.x + rect.width - 2, y };
  }

  const steps = Math.max(1, Number(options.steps || 8));
  const move = (x, y, buttons) =>
    client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: buttons ? "left" : "none",
      buttons,
    });

  await move(from.x, from.y, 0);
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: from.x,
    y: from.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, 1);
    await sleep(16);
  }
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: to.x,
    y: to.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  console.log(
    `dragged (${Math.round(from.x)}, ${Math.round(from.y)}) → (${Math.round(to.x)}, ${Math.round(to.y)})`,
  );
  client.close();
}

// Moves the pointer and leaves it there, holding nothing. What a hover is:
// `drag` presses the button, and a press is its own event — it dismisses
// tooltips, moves carets and takes focus, none of which a hover does.
async function move({ positional, options }) {
  const [x, y] = positional.map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y)) fail("which two coordinates?");
  const client = await clientFor(options);
  // Two steps: something that only reacts to movement needs to see movement,
  // and one event at the destination is a teleport.
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: x - 8,
    y,
    button: "none",
    buttons: 0,
  });
  await sleep(16);
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
  });
  console.log(`moved to (${x}, ${y})`);
  client.close();
}

const COMMANDS = {
  launch,
  benchmark,
  eval: evaluate,
  dispatch,
  reload,
  console: tailConsole,
  issues: tailIssues,
  shot,
  drag,
  move,
  throttle,
  targets,
  quit,
};

const [name, ...rest] = process.argv.slice(2);
const parsed = parseArgs(rest);
const askedForHelp = !name || name.startsWith("-") || parsed.options.help || parsed.options.h;
if (askedForHelp) {
  console.log(USAGE);
  process.exit(name ? 0 : 1);
}
if (!COMMANDS[name]) fail(`unknown command "${name}"\n\n${USAGE}`);

COMMANDS[name](parsed).catch((error) => fail(error.message));
