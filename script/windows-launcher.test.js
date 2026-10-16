"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { EventEmitter, once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { launch } = require("../resources/win/lumine");
const parseOptions = require("../src/parse-command-line-options");

const root = path.resolve(__dirname, "..");
const helper = path.join(root, "resources", "win", "lumine.js");

function fakeProcess(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.unref = () => {
    child.unreferenced = true;
  };
  child.kill = () => {
    child.exitCode = 1;
    child.emit("close", 1, null);
    return true;
  };
  return child;
}

for (const [args, foreground, expectedCode] of [
  [["project with spaces", "--", "--wait", "--add", "--new-window", "123"], false, 0],
  [["--wait=false", "project"], false, 0],
  [["--wait", "--no-wait", "project"], false, 0],
  [["--add=false", "--new-window", "project"], false, 0],
  [["--new-window", "--no-new-window", "--add"], false, 0],
  [["--add", "--new-window", "--wait"], true, 1],
  [["--add", "--new-window", "--help", "--wait"], true, 0],
  [["--add", "--new-window", "--version", "--wait"], true, 0],
  [["--add", "--new-window", "--package", "--wait"], true, 0],
  [["--uri-handler", "--wait", "lumine://test/url"], false, 0],
  [["--uri-handler", "--add", "--new-window", "lumine://test/url"], false, 0],
  [["--uri-handler", "--install", "owner/repo", "--wait", "lumine://test/url"], false, 0],
  [["--uri-handler", "--help", "--wait"], true, 0],
  ...["--help", "--version", "--test", "--list", "--link", "--install=owner/repo", "-p"].map(
    (flag) => [[flag, "--wait"], true, 0],
  ),
]) {
  test(`Windows helper classifies ${JSON.stringify(args)}`, async () => {
    const calls = [];
    const env = { ELECTRON_RUN_AS_NODE: "1", LUMINE_RESOURCE_PATH: "source", LUMINE_DEV_MODE: "1" };
    const cwd = path.resolve("project with spaces");
    const code = await launch(path.resolve("Lumine.exe"), args, {
      env,
      cwd,
      spawn(executable, argv, options) {
        const child = fakeProcess(100);
        calls.push({ executable, argv, options, child });
        process.nextTick(() => {
          child.emit("spawn");
          child.exitCode = 0;
          child.emit("close", 0, null);
        });
        return child;
      },
    });
    assert.equal(code, expectedCode);
    assert.equal(calls.length, 1, "headless and literal arguments must not start a waiter");
    assert.deepEqual(calls[0].argv, ["--executed-from", cwd, ...args]);
    assert.equal(calls[0].options.stdio, foreground ? "inherit" : "ignore");
    assert.equal(calls[0].options.detached, !foreground);
    assert.equal(calls[0].options.cwd, cwd);
    assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(calls[0].options.env.LUMINE_RESOURCE_PATH, "source");
    assert.equal(calls[0].options.env.LUMINE_DEV_MODE, "1");
    assert.equal(env.ELECTRON_RUN_AS_NODE, "1", "the caller's environment remains intact");
  });
}

test("Windows helper waits for waiter readiness and keeps waiting after a single-instance handoff", async () => {
  const children = [];
  const calls = [];
  let settled = false;
  const pending = launch(path.resolve("Lumine.exe"), ["-fw", "project"], {
    spawn(executable, args, options) {
      const child = fakeProcess(100 + children.length);
      children.push(child);
      calls.push({ executable, args, options });
      process.nextTick(() => child.emit("spawn"));
      return child;
    },
  }).then((code) => {
    settled = true;
    return code;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.length, 1);
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, "1");
  children[0].emit("message", "ready");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.length, 2);
  assert.equal(parseOptions(calls[1].args).pid, children[0].pid);
  assert.equal(calls[1].options.stdio, "inherit");
  children[1].exitCode = 0;
  children[1].emit("close", 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  children[0].kill();
  assert.equal(await pending, 0);
});

test("Windows helper cleans up the waiter after an application startup failure", async () => {
  let waiter;
  const missing = path.join(os.tmpdir(), `lumine-missing-launcher-${process.pid}`, "Lumine.exe");
  await assert.rejects(
    launch(missing, ["--wait"], {
      spawn(executable, args, options) {
        const child = spawn(executable, args, options);
        if (args[1] === "--lumine-cli-waiter") waiter = child;
        return child;
      },
    }),
    { code: "ENOENT" },
  );
  assert.ok(waiter.pid > 0);
  assert.notEqual(waiter.exitCode === null && waiter.signalCode === null, true);
  assert.throws(() => process.kill(waiter.pid, 0), { code: "ESRCH" });
});

test("Windows helper cleans up the waiter when the application exits with an error", async () => {
  const children = [];
  const pending = launch(path.resolve("Lumine.exe"), ["--wait", "project"], {
    spawn(_executable, args) {
      const child = fakeProcess(100 + children.length);
      children.push(child);
      process.nextTick(() => {
        child.emit("spawn");
        if (args[1] === "--lumine-cli-waiter") child.emit("message", "ready");
        else {
          child.exitCode = 73;
          child.emit("close", 73, null);
        }
      });
      return child;
    },
  });
  assert.equal(await pending, 73);
  assert.equal(children[0].exitCode, 1);
});

test("Windows waiter exits when its parent connection disappears", { timeout: 5000 }, async () => {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete env.CI;
  const child = spawn(process.execPath, [helper, "--lumine-cli-waiter"], {
    env,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  const exited = once(child, "exit");
  const [message] = await once(child, "message");
  assert.equal(message, "ready");
  child.disconnect();
  const [code] = await exited;
  assert.equal(code, 0);
});

function windowsQuote(value) {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

test("Windows Bash shim executes its POSIX path when only WSL path conversion is available", async (t) => {
  const bash =
    process.platform === "win32"
      ? path.join(process.env.ProgramFiles || "C:/Program Files", "Git/bin/bash.exe")
      : "/bin/bash";
  if (!fs.existsSync(bash)) {
    t.skip("Bash is unavailable");
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumine WSL transport "));
  const resources = path.join(directory, "Editor Apps", "resources");
  fs.mkdirSync(resources, { recursive: true });
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const script = path.join(resources, "lumine.sh");
  const report = path.join(directory, "argv.txt");
  fs.copyFileSync(path.join(root, "resources", "win", "lumine.sh"), script);
  fs.writeFileSync(
    path.join(resources, "..", "Lumine.exe"),
    '#!/bin/bash\nprintf "%s\\n" "$ELECTRON_RUN_AS_NODE" "$WSLENV" "$@" > "$LUMINE_TEST_REPORT"\n',
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    LUMINE_TEST_REPORT: report,
    MSYS2_ARG_CONV_EXCL: "*",
    WSLENV: "KEEP_PATH/p:KEEP_TEXT/u",
  };
  delete env.CI;
  const shellPath = (value) =>
    value.replaceAll("\\", "/").replace(/^([a-z]):\//i, (_, drive) => `/${drive.toLowerCase()}/`);
  const result = spawnSync(
    bash,
    [
      "-c",
      'command() { if [[ "$1" == -v && "$2" == cygpath ]]; then return 1; elif [[ "$1" == -v && "$2" == wslpath ]]; then return 0; else builtin command "$@"; fi; }; wslpath() { printf "windows:%s\\n" "$2"; }; source "$0" "$@"',
      shellPath(script),
      "--wait=false",
      "/mnt/c/Project with spaces",
      "--resource-path=/mnt/c/source",
      "--",
      "--wait",
    ],
    { env, encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  const argv = fs.readFileSync(report, "utf8").trimEnd().split(/\r?\n/);
  assert.equal(argv[0], "1");
  assert.equal(argv[1], "KEEP_PATH/p:KEEP_TEXT/u:ELECTRON_RUN_AS_NODE/w");
  assert.match(argv[2], /^windows:.*\/Editor Apps\/resources\/lumine\.js$/);
  assert.deepEqual(argv.slice(3), [
    "Lumine.exe",
    "--wait=false",
    "windows:/mnt/c/Project with spaces",
    "--resource-path=windows:/mnt/c/source",
    "--",
    "--wait",
  ]);
});

function fixture(t) {
  const directory = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "lumine Windows launcher ")),
  );
  const resources = path.join(directory, "Editor Apps", "resources");
  const install = path.dirname(resources);
  const cwd = path.join(directory, "project with spaces");
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(cwd);
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), fs.realpathSync.native(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  for (const name of ["lumine.cmd", "lumine.js", "lumine.sh"]) {
    fs.copyFileSync(path.join(root, "resources", "win", name), path.join(resources, name));
  }
  const parser = path.join(resources, "app.asar", "src", "parse-command-line-options.js");
  fs.mkdirSync(path.dirname(parser), { recursive: true });
  fs.copyFileSync(path.join(root, "src", "parse-command-line-options.js"), parser);
  const source = path.join(directory, "probe.cs");
  const executable = path.join(install, "Lumine.exe");
  fs.writeFileSync(
    source,
    String.raw`using System;
using System.IO;
using System.Diagnostics;
class Probe {
  static string Json(string s) { return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n") + "\""; }
  static string Quote(string s) {
    string result = "\"", slash = "";
    foreach (char c in s) {
      if (c == '\\') slash += "\\";
      else { result += c == '\"' ? slash + slash + "\\\"" : slash + c; slash = ""; }
    }
    return result + slash + slash + "\"";
  }
  static int Main(string[] args) {
    if (Environment.GetEnvironmentVariable("ELECTRON_RUN_AS_NODE") == "1") {
      string[] quoted = new string[args.Length];
      for (int i = 0; i < args.Length; i++) quoted[i] = Quote(args[i]);
      var info = new ProcessStartInfo(Environment.GetEnvironmentVariable("LUMINE_TEST_NODE"), String.Join(" ", quoted));
      info.UseShellExecute = false;
      using (var child = Process.Start(info)) { child.WaitForExit(); return child.ExitCode; }
    }
    string[] values = new string[args.Length];
    for (int i = 0; i < args.Length; i++) values[i] = Json(args[i]);
    string report = "{\"argv\":[" + String.Join(",", values) + "],\"cwd\":" + Json(Environment.CurrentDirectory) + ",\"nodeMode\":" + Json(Environment.GetEnvironmentVariable("ELECTRON_RUN_AS_NODE") ?? "") + "}";
    File.WriteAllText(Environment.GetEnvironmentVariable("LUMINE_TEST_REPORT"), report);
    Console.WriteLine("launcher probe");
    return Int32.Parse(Environment.GetEnvironmentVariable("LUMINE_TEST_EXIT") ?? "0");
  }
}`,
  );
  const compiler = path.join(
    process.env.WINDIR || "C:/Windows",
    "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
  );
  const compiled = spawnSync(compiler, ["/nologo", "/target:exe", `/out:${executable}`, source], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  let serial = 0;
  function invocation(args, { bash = false, async = false, env: extraEnv = {} } = {}) {
    const report = path.join(directory, `report-${serial++}.json`);
    const env = {
      ...process.env,
      LUMINE_TEST_NODE: process.execPath,
      LUMINE_TEST_REPORT: report,
      ...extraEnv,
    };
    delete env.CI;
    delete env.ELECTRON_RUN_AS_NODE;
    let command, argv;
    if (bash) {
      command = path.join(process.env.ProgramFiles || "C:/Program Files", "Git/bin/bash.exe");
      argv = [path.join(resources, "lumine.sh"), ...args];
    } else {
      command = process.env.ComSpec;
      argv = [
        "/d",
        "/s",
        "/c",
        `"${[path.join(resources, "lumine.cmd"), ...args].map(windowsQuote).join(" ")}"`,
      ];
    }
    const result = (async ? spawn : spawnSync)(command, argv, {
      cwd,
      env,
      encoding: "utf8",
      windowsVerbatimArguments: !bash,
      windowsHide: true,
      timeout: async ? undefined : 10000,
    });
    return { result, report };
  }
  return { directory, resources, cwd, invocation };
}

test(
  "Windows launchers load their parser from a real ASAR using bundled Electron Node",
  {
    skip: process.platform !== "win32",
    timeout: 15000,
  },
  async (t) => {
    const electron = require("electron");
    if (!fs.existsSync(electron)) {
      t.skip("Electron runtime has not been downloaded");
      return;
    }
    const asar = require("@electron/asar");
    const f = fixture(t);
    const archive = path.join(f.resources, "app.asar");
    const unpacked = path.join(f.directory, "app source");
    fs.renameSync(archive, unpacked);
    await asar.createPackage(unpacked, archive);
    t.after(() => asar.uncacheAll());
    const args = ["--foreground", "--wait=false", "C:\\Project with spaces\\", "123"];
    const { result, report } = f.invocation(args, { env: { LUMINE_TEST_NODE: electron } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual((await readReport(report)).argv, ["--executed-from", f.cwd, ...args]);
  },
);

async function readReport(file) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Launcher probe did not create ${file}`);
}

test(
  "Windows .cmd and Bash launchers preserve native arguments and complete --wait",
  { skip: process.platform !== "win32", timeout: 60000 },
  async (t) => {
    const f = fixture(t);
    for (const bash of [false, true]) {
      const bashExe = path.join(process.env.ProgramFiles || "C:/Program Files", "Git/bin/bash.exe");
      if (bash && !fs.existsSync(bashExe)) continue;
      for (const args of [
        [
          "--foreground",
          "C:\\Project with spaces\\",
          "C:\\Other project",
          "",
          "C:\\Projekt żółć",
          "C:\\A & B (draft)!\\",
          "123",
        ],
        ["--wait=false", "C:\\Project"],
        ["-f", "--", "--wait", "--add", "--new-window", "123"],
        ["--add=false", "--new-window", "-f"],
        ["--wait", "--help"],
      ]) {
        await t.test(`${bash ? "Bash" : "cmd"} ${JSON.stringify(args)}`, async () => {
          const { result, report } = f.invocation(args, { bash });
          assert.equal(result.status, 0, result.stderr);
          assert.equal(result.stderr, "");
          const actual = await readReport(report);
          assert.deepEqual(actual.argv, ["--executed-from", f.cwd, ...args]);
          assert.equal(actual.cwd, f.cwd);
          assert.equal(actual.nodeMode, "");
        });
      }
      await t.test(`${bash ? "Bash" : "cmd"} reports foreground failures`, () => {
        const { result } = f.invocation(["--version"], { bash, env: { LUMINE_TEST_EXIT: "73" } });
        assert.equal(result.status, 73, result.stderr);
        assert.match(result.stdout, /launcher probe/);
      });
      if (bash) {
        await t.test(
          "Bash converts absolute and attached path arguments without changing flags",
          async () => {
            const args = [
              "--foreground",
              "/c/Project with spaces/",
              "--resource-path=/c/source path",
              "-l/c/log path",
              "-fr/c/bundled source",
              "-fl=/c/bundled log",
              "--",
              "--link=/c/literal",
            ];
            const { result, report } = f.invocation(args, { bash });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stderr, "");
            assert.deepEqual((await readReport(report)).argv, [
              "--executed-from",
              f.cwd,
              "--foreground",
              "C:\\Project with spaces\\",
              "--resource-path=C:\\source path",
              "-lC:\\log path",
              "-frC:\\bundled source",
              "-fl=C:\\bundled log",
              "--",
              "--link=/c/literal",
            ]);
          },
        );
      }
      await t.test(
        `${bash ? "Bash" : "cmd"} --wait remains alive until the waiter is released`,
        async () => {
          const { result: child, report } = f.invocation(["-fw", "C:\\Project with spaces\\"], {
            bash,
            async: true,
          });
          const closed = once(child, "close");
          let waiterPid;
          try {
            const actual = await readReport(report);
            waiterPid = parseOptions(actual.argv).pid;
            assert.ok(waiterPid > 0);
            await new Promise((resolve) => setTimeout(resolve, 100));
            assert.equal(child.exitCode, null);
            process.kill(waiterPid);
            const [code] = await closed;
            assert.equal(code, 0);
          } finally {
            if (child.exitCode === null) {
              spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
                windowsHide: true,
                stdio: "ignore",
              });
              await closed;
            }
            if (waiterPid) {
              try {
                process.kill(waiterPid);
              } catch (error) {
                assert.equal(error.code, "ESRCH");
              }
            }
          }
        },
      );
    }
  },
);
