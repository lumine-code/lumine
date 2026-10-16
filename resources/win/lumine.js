"use strict";

const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

// Installed launchers live beside app.asar. The source copy remains directly
// runnable, including from the launcher's own integration tests.
const parserPath = fs.existsSync(path.join(__dirname, "app.asar"))
  ? path.join(__dirname, "app.asar", "src", "parse-command-line-options")
  : path.join(__dirname, "..", "..", "src", "parse-command-line-options");
const parseOptions = require(parserPath);
const WAITER = "--lumine-cli-waiter";
const OUTPUT_OPTIONS = [
  "foreground",
  "help",
  "version",
  "test",
  "package",
  "install",
  "uninstall",
  "list",
  "link",
  "unlink",
];
const HEADLESS_OPTIONS = OUTPUT_OPTIONS.filter((name) => name !== "foreground");

function hasOption(options, name) {
  return ["install", "uninstall", "link", "unlink"].includes(name)
    ? Object.hasOwn(options, name)
    : Boolean(options[name]);
}

function observe(child) {
  let spawned = false;
  const ready = new Promise((resolve, reject) => {
    child.once("spawn", () => {
      spawned = true;
      resolve();
    });
    child.once("error", reject);
  });
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    // An error before spawn is reported through ready. Keep an error listener
    // for later process errors without turning one into an uncaught exception.
    child.on("error", (error) => {
      if (spawned) resolve({ code: 1, error });
    });
  });
  return { ready, closed };
}

function exitCode({ code, signal }) {
  return code ?? (signal ? 1 : 0);
}

async function launch(
  executable,
  args,
  { spawn = childProcess.spawn, env = process.env, cwd = process.cwd() } = {},
) {
  let options = parseOptions(args);
  // Core handles these early exits before --uri-handler; URI handling then
  // discards the other editor options, including --wait and its PID.
  if (options["uri-handler"] && !options.help && !options.version && !options.package) {
    options = { foreground: options.foreground };
  }
  const conflict = Boolean(
    options.add && options["new-window"] && !options.help && !options.version && !options.package,
  );
  const foreground = conflict || OUTPUT_OPTIONS.some((name) => hasOption(options, name));
  const wait =
    Boolean(options.wait) &&
    !conflict &&
    !HEADLESS_OPTIONS.some((name) => hasOption(options, name));
  const childEnv = { ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  childEnv.LUMINE_BASE_NAME = path.basename(__filename, ".js");
  if (Object.hasOwn(options, "enable-electron-logging")) {
    if (options["enable-electron-logging"]) childEnv.ELECTRON_ENABLE_LOGGING = "1";
    else delete childEnv.ELECTRON_ENABLE_LOGGING;
  }
  const appArgs = ["--executed-from", cwd, ...args];

  if (!wait) {
    const child = spawn(executable, appArgs, {
      cwd,
      env: childEnv,
      detached: !foreground,
      stdio: foreground ? "inherit" : "ignore",
      windowsHide: true,
    });
    const observed = observe(child);
    await observed.ready;
    if (!foreground) {
      child.unref();
      return 0;
    }
    const code = exitCode(await observed.closed);
    return conflict && code === 0 ? 1 : code;
  }

  // The app ends --wait by killing the supplied PID. A separate waiter lets
  // this launcher report success even on Windows, where that kill cannot be
  // trapped. Its IPC disconnect handler also cleans up if this launcher dies.
  const waiter = spawn(process.execPath, [__filename, WAITER], {
    cwd,
    env: { ...childEnv, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  const waiterObserved = observe(waiter);
  const waiterReady = new Promise((resolve, reject) => {
    waiter.once("message", (message) => {
      if (message === "ready") resolve();
      else reject(new Error("The Lumine wait process did not initialize."));
    });
    waiterObserved.closed.then(() =>
      reject(new Error("The Lumine wait process exited before initialization.")),
    );
    waiterObserved.ready.catch(reject);
  });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  let signalExit;
  const interrupted = new Promise((resolve) => {
    signalExit = resolve;
  });
  const onSignal = () => signalExit(1);
  for (const signal of signals) process.on(signal, onSignal);

  try {
    const initialized = await Promise.race([
      waiterReady.then(() => true),
      interrupted.then(() => false),
    ]);
    if (!initialized) return 1;
    appArgs.unshift("--pid", String(waiter.pid));
    const child = spawn(executable, appArgs, {
      cwd,
      env: childEnv,
      detached: true,
      stdio: foreground ? "inherit" : "ignore",
      windowsHide: true,
    });
    const observed = observe(child);
    await observed.ready;
    child.unref();
    const failed = observed.closed.then((result) => {
      // A second app process normally exits 0 after handing its request to
      // the running editor. That does not mean the file has closed yet.
      if (exitCode(result) === 0) return new Promise(() => {});
      return exitCode(result);
    });
    return await Promise.race([waiterObserved.closed.then(() => 0), failed, interrupted]);
  } finally {
    for (const signal of signals) process.removeListener(signal, onSignal);
    if (waiter.exitCode === null && waiter.signalCode === null) waiter.kill();
    await waiterObserved.closed;
  }
}

function runWaiter() {
  if (!process.send) throw new Error("The Lumine wait process requires its parent connection.");
  process.on("disconnect", () => process.exit(0));
  process.send("ready", (error) => {
    if (error) process.exit(0);
  });
}

if (require.main === module) {
  if (process.argv[2] === WAITER) {
    runWaiter();
  } else {
    // Preserve the original `node lumine.js Lumine.exe ...args` interface.
    const executable = process.argv[2];
    const pending = executable
      ? launch(path.resolve(__dirname, "..", executable), process.argv.slice(3))
      : Promise.reject(new Error("The Lumine executable was not specified."));
    pending
      .then((code) => {
        process.exitCode = code;
      })
      .catch((error) => {
        console.error(`Unable to start Lumine: ${error.message}`);
        process.exitCode = 1;
      });
  }
}

module.exports = { launch };
