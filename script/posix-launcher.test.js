"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const test = require("node:test");
const parseOptions = require("../src/parse-command-line-options");

const root = path.resolve(__dirname, "..");
const bash =
  process.platform === "win32"
    ? path.join(process.env.ProgramFiles || "C:/Program Files", "Git/bin/bash.exe")
    : "/bin/bash";
let windowsExecutable;

function shellPath(value) {
  return value
    .replaceAll("\\", "/")
    .replace(/^([a-z]):\//i, (_, drive) => `/${drive.toLowerCase()}/`);
}

function executable(filePath, source) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

function fakeElectron(filePath, directory) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (process.platform !== "win32") {
    executable(
      filePath,
      '#!/bin/bash\nif [ "$ELECTRON_RUN_AS_NODE" = 1 ]; then printf \'{"pid":%s}\\n\' "$$" > "$LUMINE_TEST_BOOTSTRAP"; exec "$LUMINE_TEST_NODE" "$@"; fi\nexec "$LUMINE_TEST_NODE" "$LUMINE_TEST_PROBE" "$@"\n',
    );
    return;
  }
  if (!windowsExecutable) {
    const source = path.join(directory, "electron-probe.cs");
    const compiledPath = path.join(directory, "electron-probe.exe");
    fs.writeFileSync(
      source,
      String.raw`using System;
using System.IO;
using System.Diagnostics;
class Probe {
  static string Quote(string s) {
    string result = "\"", slash = "";
    foreach (char c in s) {
      if (c == '\\') slash += "\\";
      else { result += c == '\"' ? slash + slash + "\\\"" : slash + c; slash = ""; }
    }
    return result + slash + slash + "\"";
  }
  static string NativePath(string s) {
    return s.Length > 3 && s[0] == '/' && s[2] == '/' && Char.IsLetter(s[1])
      ? s[1] + ":" + s.Substring(2).Replace('/', '\\') : s;
  }
  static int Main(string[] args) {
    bool nodeMode = Environment.GetEnvironmentVariable("ELECTRON_RUN_AS_NODE") == "1";
    string[] forwarded = new string[args.Length + (nodeMode ? 0 : 1)];
    if (!nodeMode) forwarded[0] = Quote(Environment.GetEnvironmentVariable("LUMINE_TEST_PROBE"));
    for (int i = 0; i < args.Length; i++) {
      // Bootstrap paths are POSIX on the forced-Unix Windows fixture. User
      // arguments retain their original bytes, including literal POSIX paths.
      string value = nodeMode && i < 2 ? NativePath(args[i]) : args[i];
      if (nodeMode && i == 1) value += ".exe";
      forwarded[i + (nodeMode ? 0 : 1)] = Quote(value);
    }
    var info = new ProcessStartInfo(Environment.GetEnvironmentVariable("LUMINE_TEST_NODE"), String.Join(" ", forwarded));
    info.UseShellExecute = false;
    bool readInput = Environment.GetEnvironmentVariable("LUMINE_TEST_READ_STDIN") == "1";
    info.RedirectStandardInput = readInput;
    using (var child = Process.Start(info)) {
      if (nodeMode) File.WriteAllText(Environment.GetEnvironmentVariable("LUMINE_TEST_BOOTSTRAP"), "{\"pid\":" + child.Id + ",\"parentPid\":" + Process.GetCurrentProcess().Id + "}");
      if (readInput) { Console.OpenStandardInput().CopyTo(child.StandardInput.BaseStream); child.StandardInput.Close(); }
      child.WaitForExit(); return child.ExitCode;
    }
  }
}`,
    );
    const compiler = path.join(
      process.env.WINDIR || "C:/Windows",
      "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
    );
    const result = spawnSync(compiler, ["/nologo", "/target:exe", `/out:${compiledPath}`, source], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    windowsExecutable = fs.readFileSync(compiledPath);
  }
  fs.writeFileSync(filePath, windowsExecutable);
  fs.writeFileSync(filePath + ".exe", windowsExecutable);
}

async function waitForOwnedProcessExit(pid) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Launcher fixture process ${pid} did not exit before cleanup.`);
}

function terminateOwnedProcess(pid) {
  assert.ok(Number.isInteger(pid) && pid > 1 && pid !== process.pid);
  try {
    process.kill(pid, 0);
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function waitForOwnedProcessesExit(values) {
  const pids = [
    ...new Set(values.filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid)),
  ];
  if (process.platform !== "win32") {
    for (const pid of pids) await waitForOwnedProcessExit(pid);
    return;
  }
  if (!pids.length) return;
  // Signal 0 can observe an exit code while Windows is still unloading the
  // native adapter. Wait on the exact process handles before removing its EXE.
  const command = `$ErrorActionPreference = "Stop"; foreach ($fixturePid in @(${pids.join(",")})) { try { $fixtureProcess = [Diagnostics.Process]::GetProcessById($fixturePid) } catch [ArgumentException] { continue }; try { if (-not $fixtureProcess.WaitForExit(10000)) { throw "Fixture process $fixturePid did not exit" } } finally { $fixtureProcess.Dispose() } }; exit 0`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 12000,
      windowsHide: true,
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

function fileReady(filePath) {
  let watcher;
  let timer;
  const ready = new Promise((resolve, reject) => {
    const finish = (error) => {
      watcher?.close();
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const check = () => {
      if (fs.existsSync(filePath)) finish();
    };
    watcher = fs.watch(path.dirname(filePath), check);
    watcher.once("error", finish);
    timer = setTimeout(() => finish(new Error(`No fixture readiness marker: ${filePath}`)), 10000);
    check();
  });
  return {
    ready,
    close: () => {
      watcher?.close();
      clearTimeout(timer);
    },
  };
}

function fixture(t, platform = "Linux") {
  const directory = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "lumine launcher ")),
  );
  const install = path.join(directory, "Editor Apps", "Lumine");
  const app = path.join(install, "Lumine.app");
  const resources =
    platform === "Darwin"
      ? path.join(app, "Contents", "Resources")
      : path.join(install, "resources");
  const nativeExecutable =
    platform === "Darwin"
      ? path.join(app, "Contents", "MacOS", "Lumine")
      : path.join(install, "lumine");
  const script = path.join(resources, "lumine.sh");
  fs.mkdirSync(resources, { recursive: true });
  fs.copyFileSync(path.join(root, "lumine.sh"), script);
  fs.copyFileSync(path.join(root, "resources", "lumine.js"), path.join(resources, "lumine.js"));
  const parser = path.join(resources, "app.asar", "src", "parse-command-line-options.js");
  fs.mkdirSync(path.dirname(parser), { recursive: true });
  fs.copyFileSync(path.join(root, "src", "parse-command-line-options.js"), parser);
  const probe = path.join(directory, "probe.js");
  fs.writeFileSync(
    probe,
    `const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const options = require(process.env.LUMINE_TEST_PARSER)(argv);
const homeExisted = fs.existsSync(process.env.LUMINE_HOME);
let input = null;
if (process.env.LUMINE_TEST_READ_STDIN) {
  input = "";
  const byte = Buffer.alloc(1);
  while (!input.endsWith("\\n") && fs.readSync(0, byte, 0, 1, null)) input += byte.toString("utf8");
}
if (process.env.LUMINE_TEST_SEED) require(process.env.LUMINE_TEST_PATHS).seedUserConfig(process.env.LUMINE_TEST_RESOURCES);
if (process.env.LUMINE_TEST_RELEASE || process.env.LUMINE_TEST_KEEPALIVE) {
  const release = process.env.LUMINE_TEST_RELEASE;
  const keepalive = process.env.LUMINE_TEST_KEEPALIVE;
  let released = false;
  const watcher = fs.watch(path.dirname(release || keepalive), () => {
    if (options.wait && !released && release && fs.existsSync(release)) { released = true; process.kill(options.pid, "SIGTERM"); }
    if ((keepalive && fs.existsSync(keepalive)) || (released && !keepalive)) watcher.close();
  });
}
if (process.env.LUMINE_TEST_PROBE_EXITED) process.on("exit", () => fs.writeFileSync(process.env.LUMINE_TEST_PROBE_EXITED, "exited\\n"));
const report = { pid: process.pid, parentPid: process.ppid, waiterPid: options.wait ? options.pid : null, argv, input, home: process.env.LUMINE_HOME, homeExisted,
  seeded: fs.existsSync(path.join(process.env.LUMINE_HOME, "init.js")), nodeMode: process.env.ELECTRON_RUN_AS_NODE ?? null,
  shellEnvironment: process.env.LUMINE_DISABLE_SHELLING_OUT_FOR_ENVIRONMENT,
  resourcePath: process.env.LUMINE_RESOURCE_PATH, devMode: process.env.LUMINE_DEV_MODE, logging: process.env.ELECTRON_ENABLE_LOGGING };
fs.writeFileSync(process.env.LUMINE_TEST_REPORT + ".tmp", JSON.stringify(report));
fs.renameSync(process.env.LUMINE_TEST_REPORT + ".tmp", process.env.LUMINE_TEST_REPORT);
console.log("launcher probe");
process.exitCode = Number(process.env.LUMINE_TEST_EXIT || 0);
`,
  );
  fakeElectron(nativeExecutable, directory);
  const bin = path.join(directory, "bin");
  executable(path.join(bin, "uname"), `#!/bin/bash\nprintf '%s\\n' '${platform}'\n`);
  const defaults = path.join(directory, "defaults");
  fs.mkdirSync(path.join(defaults, "dot-lumine"), { recursive: true });
  fs.writeFileSync(path.join(defaults, "dot-lumine", "init.js"), "// default init\n");
  const cwd = path.join(directory, "project with spaces");
  fs.mkdirSync(cwd);
  const env = {
    ...process.env,
    HOME: shellPath(directory),
    LUMINE_HOME: shellPath(path.join(directory, "fresh-config")),
    LUMINE_PATH: "",
    LUMINE_TEST_BIN: shellPath(bin),
    LUMINE_TEST_SCRIPT: shellPath(script),
    LUMINE_TEST_NODE: shellPath(process.execPath),
    LUMINE_TEST_PROBE: probe,
    LUMINE_TEST_BOOTSTRAP: path.join(directory, "bootstrap.json"),
    LUMINE_TEST_REPORT: path.join(directory, "report.json"),
    LUMINE_TEST_PARSER: path.join(root, "src", "parse-command-line-options.js"),
    LUMINE_TEST_PATHS: path.join(root, "src", "lumine-paths.js"),
    LUMINE_TEST_RESOURCES: defaults,
    TMPDIR: shellPath(directory),
    MSYS2_ARG_CONV_EXCL: "*",
  };
  for (const name of [
    "CI",
    "REDIRECT_STDERR",
    "LUMINE_TEST_RELEASE",
    "LUMINE_TEST_SEED",
    "LUMINE_TEST_EXIT",
    "LUMINE_TEST_KEEPALIVE",
    "LUMINE_TEST_PROBE_EXITED",
    "LUMINE_TEST_READ_STDIN",
    "APPIMAGE",
    "TERM",
    "LUMINE_DISABLE_SHELLING_OUT_FOR_ENVIRONMENT",
  ])
    delete env[name];
  const children = [];
  t.after(async () => {
    for (const key of ["LUMINE_TEST_KEEPALIVE", "LUMINE_TEST_RELEASE"])
      if (env[key]) fs.writeFileSync(env[key], "fixture cleanup\n");
    const bootstrap = fs.existsSync(env.LUMINE_TEST_BOOTSTRAP)
      ? JSON.parse(fs.readFileSync(env.LUMINE_TEST_BOOTSTRAP, "utf8"))
      : null;
    // A failed readiness check can leave both the native wrapper and its
    // Electron-Node helper alive. Stop the exact owned helper before awaiting
    // the wrapper; killing only MSYS or the managed adapter leaves that child.
    if (bootstrap) terminateOwnedProcess(bootstrap.pid);
    const report = fs.existsSync(env.LUMINE_TEST_REPORT)
      ? JSON.parse(fs.readFileSync(env.LUMINE_TEST_REPORT, "utf8"))
      : null;
    await waitForOwnedProcessesExit([
      bootstrap?.pid,
      bootstrap?.parentPid,
      report?.pid,
      report?.parentPid,
    ]);
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null && child.pid)
        terminateOwnedProcess(child.pid);
      await closed;
    }
    assert.equal(path.dirname(directory), fs.realpathSync.native(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const launch = (args, options = {}) => {
    const shellArgs = [
      "-c",
      'export PATH="$LUMINE_TEST_BIN:$PATH"; exec bash "$LUMINE_TEST_SCRIPT" "$@"',
      "launcher-test",
      ...args,
    ];
    const child = (options.async ? spawn : spawnSync)(bash, shellArgs, {
      cwd,
      env,
      encoding: "utf8",
      timeout: options.async ? undefined : 10000,
      ...options,
    });
    if (options.async) children.push({ child, closed: once(child, "close") });
    else assert.equal(child.error, undefined, child.error?.message);
    return child;
  };
  return {
    directory,
    env,
    launch,
    script,
    nativeExecutable,
    resources,
    report: async () => {
      await fileReady(env.LUMINE_TEST_REPORT).ready;
      return JSON.parse(fs.readFileSync(env.LUMINE_TEST_REPORT, "utf8"));
    },
  };
}

for (const platform of ["Linux", "Darwin"]) {
  for (const args of [
    ["project", "--version"],
    ["--resource-path", "/source", "--test", "spec"],
    ["--user-data-dir", "/profile", "--help"],
    ["--resource-path=/source", "project", "-tf"],
    ["--add", "project", "--new-window"],
    ["--new-window", "--no-new-window", "--add", "project", "-f"],
    ["--foreground=false", "--foreground", "project"],
    ["--foreground=value=false", "project"],
    ["-r/source", "project", "-h"],
    ["-r", "--wait", "project", "--version"],
    ["-r", "-psn_123", "--wait", "project", "--version"],
    ["--link", "project"],
    ["project", "--wait", "--version"],
    ["--wait", "--list"],
    ["--wait", "--link", "project"],
    ["project", "--wait", "-tf"],
    ["--add", "--new-window", "--help"],
    ["--add", "--new-window", "--version"],
  ]) {
    test(`${platform} forwards options through the common helper: ${JSON.stringify(args)}`, async (t) => {
      const f = fixture(t, platform);
      const result = f.launch(args);
      const options = parseOptions(args);
      assert.equal(
        result.status,
        options.add && options["new-window"] && !options.help && !options.version ? 1 : 0,
        result.stderr,
      );
      assert.match(result.stdout, /launcher probe/);
      const report = await f.report();
      assert.deepEqual(report.argv.slice(platform === "Linux" ? 3 : 2), args);
      assert.equal(report.homeExisted, false);
      assert.equal(report.nodeMode, null);
    });
  }

  for (const args of [
    ["--help=false", "project"],
    ["--help", "--no-help", "project"],
    ["--foreground", "--no-foreground", "project"],
    ["--", "--wait", "--help"],
    ["--uri-handler", "--wait", "lumine://settings"],
    ["--uri-handler", "--add", "--new-window", "lumine://settings"],
    ["--uri-handler", "--test", "--list", "lumine://settings"],
    ["--uri-handler", "--no-uri-handler", "--help=false", "project"],
    ["--", "--uri-handler", "--wait"],
    ["-r", "-psn_123", "--", "--wait"],
  ]) {
    test(`${platform} detaches silently for disabled or literal options: ${JSON.stringify(args)}`, async (t) => {
      const f = fixture(t, platform);
      const result = f.launch(args);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
      const report = await f.report();
      assert.deepEqual(parseOptions(report.argv)._, parseOptions(args)._);
      assert.equal(report.nodeMode, null);
    });
  }

  test(`${platform} preserves literal and empty arguments after --`, async (t) => {
    const f = fixture(t, platform);
    const args = [
      "-f",
      "--",
      "--wait",
      "--new-window",
      "-notes.txt",
      "",
      "file with spaces",
      "123",
    ];
    const result = f.launch(args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parseOptions((await f.report()).argv)._, args.slice(2));
  });

  test(`${platform} lets core seed fresh configuration through a detached launch`, async (t) => {
    const f = fixture(t, platform);
    f.env.LUMINE_TEST_SEED = "1";
    const result = f.launch(["project"]);
    assert.equal(result.status, 0, result.stderr);
    const report = await f.report();
    assert.equal(report.homeExisted, false);
    assert.equal(report.seeded, true);
  });

  test(`${platform} derives default home from a script path with spaces`, async (t) => {
    const f = fixture(t, platform);
    delete f.env.LUMINE_HOME;
    const result = f.launch(["-f"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(shellPath((await f.report()).home), `${shellPath(f.directory)}/.lumine`);
  });

  test(`${platform} preserves stdin and returns failure for --foreground with --wait`, async (t) => {
    const f = fixture(t, platform);
    f.env.LUMINE_TEST_READ_STDIN = "1";
    f.env.LUMINE_TEST_EXIT = "7";
    const result = f.launch(["--wait", "-f"], { input: "launcher input\n" });
    assert.equal(result.status, 7, result.stderr);
    const report = await f.report();
    assert.equal(report.input, "launcher input\n");
    assert.throws(() => process.kill(report.waiterPid, 0), { code: "ESRCH" });
  });

  for (const args of [[], ["-f"], ["--wait"]]) {
    test(`${platform} applies common failure policy for ${JSON.stringify(args)}`, async (t) => {
      const f = fixture(t, platform);
      f.env.LUMINE_TEST_EXIT = "7";
      const result = f.launch(args);
      assert.equal(result.status, args.length ? 7 : 0, result.stderr);
      if (args.includes("-f")) assert.match(result.stdout, /launcher probe/);
      else assert.equal(result.stdout, "");
      const report = await f.report();
      if (args.includes("--wait"))
        assert.throws(() => process.kill(report.waiterPid, 0), { code: "ESRCH" });
    });
  }

  for (const foreground of [false, true]) {
    test(
      `${platform} --wait${foreground ? " -f" : ""} releases while the application remains alive`,
      { timeout: 15000 },
      async (t) => {
        const f = fixture(t, platform);
        f.env.LUMINE_TEST_RELEASE = path.join(f.directory, "release");
        f.env.LUMINE_TEST_KEEPALIVE = path.join(f.directory, "stop-probe");
        f.env.LUMINE_TEST_PROBE_EXITED = path.join(f.directory, "probe-exited");
        const child = f.launch(["project", "--wait", ...(foreground ? ["-f"] : [])], {
          async: true,
          stdio: "ignore",
        });
        const closed = once(child, "close");
        const report = await f.report();
        assert.equal(child.exitCode, null);
        process.kill(report.waiterPid, 0);
        fs.writeFileSync(f.env.LUMINE_TEST_RELEASE, "release\n");
        assert.deepEqual(await closed, [0, null]);
        assert.equal(fs.existsSync(f.env.LUMINE_TEST_PROBE_EXITED), false);
        const exited = fileReady(f.env.LUMINE_TEST_PROBE_EXITED);
        t.after(exited.close);
        fs.writeFileSync(f.env.LUMINE_TEST_KEEPALIVE, "stop\n");
        await exited.ready;
      },
    );
  }

  test(`${platform} preserves development and shell environment settings`, async (t) => {
    const f = fixture(t, platform);
    f.env.LUMINE_DEV_MODE = "1";
    f.env.LUMINE_RESOURCE_PATH = path.join(f.directory, "source");
    f.env.LUMINE_DISABLE_SHELLING_OUT_FOR_ENVIRONMENT = "custom";
    const result = f.launch(["-f", "--enable-electron-logging"]);
    assert.equal(result.status, 0, result.stderr);
    const report = await f.report();
    assert.equal(report.devMode, "1");
    assert.equal(report.resourcePath, f.env.LUMINE_RESOURCE_PATH);
    assert.equal(report.shellEnvironment, "custom");
    assert.equal(report.logging, "1");
  });
}

test("Darwin resolves a relative launcher symlink from an unrelated project", async (t) => {
  const f = fixture(t, "Darwin");
  const link = path.join(f.directory, "bin", "lumine");
  try {
    fs.symlinkSync(path.relative(path.dirname(link), f.script), link, "file");
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
    t.skip("Native file symlinks are unavailable");
    return;
  }
  f.env.LUMINE_TEST_SCRIPT = shellPath(link);
  const result = f.launch(["-f", "project"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /launcher probe/);
  await f.report();
});

for (const args of [[], ["--wait"]]) {
  test(`Linux rejects a missing executable before bootstrap for ${JSON.stringify(args)}`, (t) => {
    const f = fixture(t);
    f.env.LUMINE_PATH = shellPath(path.join(f.directory, "missing"));
    const result = f.launch(args);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Cannot execute/);
    assert.equal(fs.existsSync(f.env.LUMINE_TEST_BOOTSTRAP), false);
  });
  test(
    `Linux rejects a non-executable binary for ${JSON.stringify(args)}`,
    { skip: process.platform === "win32" && "Windows does not enforce POSIX executable mode" },
    (t) => {
      const f = fixture(t);
      fs.chmodSync(f.nativeExecutable, 0o644);
      const result = f.launch(args);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Cannot execute/);
    },
  );
}

test("Linux reports a missing installed helper before bootstrap", (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.resources, "lumine.js"));
  const result = f.launch([]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Cannot locate the Lumine launcher helper/);
  assert.equal(fs.existsSync(f.env.LUMINE_TEST_BOOTSTRAP), false);
});

test(
  "Linux detaches without waiting for the application's lifetime",
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t);
    f.env.LUMINE_TEST_KEEPALIVE = path.join(f.directory, "stop-probe");
    f.env.LUMINE_TEST_PROBE_EXITED = path.join(f.directory, "probe-exited");
    const child = f.launch(["project"], { async: true, stdio: "ignore" });
    const closed = once(child, "close");
    const report = await f.report();
    assert.deepEqual(await closed, [0, null]);
    process.kill(report.pid, 0);
    const bootstrap = JSON.parse(fs.readFileSync(f.env.LUMINE_TEST_BOOTSTRAP, "utf8"));
    assert.throws(() => process.kill(bootstrap.pid, 0), { code: "ESRCH" });
    const exited = fileReady(f.env.LUMINE_TEST_PROBE_EXITED);
    t.after(exited.close);
    fs.writeFileSync(f.env.LUMINE_TEST_KEEPALIVE, "stop\n");
    await exited.ready;
  },
);

test("Linux resolves a relative LUMINE_PATH with spaces before invoking the helper", async (t) => {
  const f = fixture(t);
  f.env.LUMINE_PATH = path
    .relative(path.join(f.directory, "project with spaces"), path.dirname(f.nativeExecutable))
    .replaceAll("\\", "/");
  const result = f.launch(["-f", "project"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /launcher probe/);
  await f.report();
});

test("Linux source launcher uses its sibling helper ahead of the installed helper", async (t) => {
  const f = fixture(t);
  const checkout = path.join(f.directory, "source checkout");
  fs.cpSync(f.resources, path.join(checkout, "resources"), { recursive: true });
  fs.copyFileSync(f.script, path.join(checkout, "lumine.sh"));
  fs.unlinkSync(path.join(f.resources, "lumine.js"));
  f.env.LUMINE_TEST_SCRIPT = shellPath(path.join(checkout, "lumine.sh"));
  f.env.LUMINE_PATH = shellPath(path.dirname(f.nativeExecutable));
  const result = f.launch(["-f", "project"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /launcher probe/);
  await f.report();
});

test(
  "Darwin derives the executable name after Spotlight discovers a renamed bundle",
  {
    skip:
      process.platform === "darwin" &&
      fs.existsSync("/Applications/Lumine.app") &&
      "The regular installation takes precedence over Spotlight",
  },
  async (t) => {
    const f = fixture(t, "Darwin");
    const app = path.dirname(path.dirname(f.resources));
    const renamedApp = path.join(path.dirname(app), "Lumine Preview.app");
    fs.renameSync(app, renamedApp);
    const macos = path.join(renamedApp, "Contents", "MacOS");
    fs.renameSync(path.join(macos, "Lumine"), path.join(macos, "Lumine Preview"));
    if (process.platform === "win32")
      fs.renameSync(path.join(macos, "Lumine.exe"), path.join(macos, "Lumine Preview.exe"));
    const script = path.join(f.directory, "bin", "lumine");
    fs.copyFileSync(path.join(root, "lumine.sh"), script);
    executable(
      path.join(f.directory, "bin", "mdfind"),
      '#!/bin/bash\nprintf "%s\\n" "$LUMINE_TEST_SPOTLIGHT"\n',
    );
    f.env.LUMINE_TEST_SCRIPT = shellPath(script);
    f.env.LUMINE_TEST_SPOTLIGHT = shellPath(renamedApp);
    const result = f.launch(["-f"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /launcher probe/);
    await f.report();
  },
);

for (const explicit of [undefined, "true"]) {
  test(`Linux desktop AppImage environment policy honors ${String(explicit)}`, async (t) => {
    const f = fixture(t);
    f.env.APPIMAGE = "/opt/Lumine.AppImage";
    f.env.TERM = "dumb";
    if (explicit) f.env.LUMINE_DISABLE_SHELLING_OUT_FOR_ENVIRONMENT = explicit;
    const result = f.launch(["-f"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await f.report()).shellEnvironment, explicit || "false");
  });
}

test(
  "Fixture cleanup stops a helper that remains alive after the test body",
  { timeout: 15000 },
  async (t) => {
    let directory;
    let helperPid;
    let wrapperPid;
    await t.test("leave an owned helper running for teardown", async (s) => {
      const f = fixture(s);
      directory = f.directory;
      const ready = path.join(directory, "stalled-helper-ready");
      f.env.LUMINE_TEST_HELPER_READY = ready;
      fs.writeFileSync(
        path.join(f.resources, "lumine.js"),
        'const fs = require("node:fs");\nfs.writeFileSync(process.env.LUMINE_TEST_HELPER_READY, "ready\\n");\nsetInterval(() => {}, 1000);\n',
      );
      const child = f.launch([], { async: true, stdio: "ignore" });
      wrapperPid = child.pid;
      await fileReady(ready).ready;
      await fileReady(f.env.LUMINE_TEST_BOOTSTRAP).ready;
      helperPid = JSON.parse(fs.readFileSync(f.env.LUMINE_TEST_BOOTSTRAP, "utf8")).pid;
      assert.equal(child.exitCode, null);
      process.kill(helperPid, 0);
    });
    assert.equal(fs.existsSync(directory), false);
    assert.throws(() => process.kill(helperPid, 0), { code: "ESRCH" });
    assert.throws(() => process.kill(wrapperPid, 0), { code: "ESRCH" });
  },
);
