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

function shellPath(value) {
  return value
    .replaceAll("\\", "/")
    .replace(/^([a-z]):\//i, (_, drive) => `/${drive.toLowerCase()}/`);
}

function executable(filePath, source) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

function fixture(t, platform = "Linux") {
  const directory = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "lumine launcher ")),
  );
  t.after(() =>
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  );
  const install = path.join(directory, "Editor Apps", "Lumine");
  const app = path.join(install, "Lumine.app");
  const script =
    platform === "Darwin"
      ? path.join(app, "Contents", "Resources", "lumine.sh")
      : path.join(install, "resources", "lumine.sh");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(path.join(root, "lumine.sh"), script);
  const probe = path.join(directory, "probe.js");
  fs.writeFileSync(
    probe,
    `const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const argv = process.argv.slice(2);
const options = require(process.env.LUMINE_TEST_PARSER)(argv);
const homeExisted = fs.existsSync(process.env.LUMINE_HOME);
const input = process.env.LUMINE_TEST_READ_STDIN ? fs.readFileSync(0, "utf8") : null;
if (process.env.LUMINE_TEST_SEED) {
  require(process.env.LUMINE_TEST_PATHS).seedUserConfig(process.env.LUMINE_TEST_RESOURCES);
}
if (options.wait && process.env.LUMINE_TEST_RELEASE) {
  const release = process.env.LUMINE_TEST_RELEASE;
  const keepalive = process.env.LUMINE_TEST_KEEPALIVE;
  let released = false;
  const watcher = fs.watch(path.dirname(release), () => {
    if (!released && fs.existsSync(release)) {
      released = true;
      const result = spawnSync(process.env.LUMINE_TEST_BASH, ["-c", 'kill -TERM "$1"', "release", String(options.pid)], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
    }
    if (released && (!keepalive || fs.existsSync(keepalive))) watcher.close();
  });
}
if (process.env.LUMINE_TEST_PROBE_EXITED) {
  process.on("exit", () => fs.writeFileSync(process.env.LUMINE_TEST_PROBE_EXITED, "exited\\n"));
}
const report = { argv, input, home: process.env.LUMINE_HOME, homeExisted, seeded: fs.existsSync(path.join(process.env.LUMINE_HOME, "init.js")) };
fs.writeFileSync(process.env.LUMINE_TEST_REPORT + ".tmp", JSON.stringify(report));
fs.renameSync(process.env.LUMINE_TEST_REPORT + ".tmp", process.env.LUMINE_TEST_REPORT);
console.log("launcher probe");
process.exitCode = Number(process.env.LUMINE_TEST_EXIT || 0);
`,
  );
  executable(
    platform === "Darwin"
      ? path.join(app, "Contents", "MacOS", "Lumine")
      : path.join(install, "lumine"),
    '#!/bin/bash\nexec "$LUMINE_TEST_NODE" "$LUMINE_TEST_PROBE" "$@"\n',
  );
  const bin = path.join(directory, "bin");
  executable(path.join(bin, "uname"), `#!/bin/bash\nprintf '%s\\n' '${platform}'\n`);
  executable(
    path.join(bin, "open"),
    '#!/bin/bash\nif [ -n "$LUMINE_TEST_OPEN_EXIT" ]; then exit "$LUMINE_TEST_OPEN_EXIT"; fi\nwhile [ "$#" -gt 0 ] && [ "$1" != --args ]; do shift; done\nshift\nexec "$LUMINE_TEST_APP" "$@" >/dev/null 2>&1\n',
  );
  const resources = path.join(directory, "defaults");
  fs.mkdirSync(path.join(resources, "dot-lumine"), { recursive: true });
  fs.writeFileSync(path.join(resources, "dot-lumine", "init.js"), "// default init\n");
  const cwd = path.join(directory, "project with spaces");
  fs.mkdirSync(cwd);
  const env = {
    ...process.env,
    HOME: shellPath(directory),
    LUMINE_HOME: shellPath(path.join(directory, "fresh-config")),
    LUMINE_PATH: "",
    LUMINE_TEST_APP: shellPath(path.join(app, "Contents", "MacOS", "Lumine")),
    LUMINE_TEST_BIN: shellPath(bin),
    LUMINE_TEST_SCRIPT: shellPath(script),
    LUMINE_TEST_NODE: shellPath(process.execPath),
    LUMINE_TEST_PROBE: probe,
    LUMINE_TEST_REPORT: path.join(directory, "report.json"),
    LUMINE_TEST_PARSER: path.join(root, "src", "parse-command-line-options.js"),
    LUMINE_TEST_PATHS: path.join(root, "src", "lumine-paths.js"),
    LUMINE_TEST_RESOURCES: resources,
    LUMINE_TEST_BASH: bash,
    TMPDIR: shellPath(directory),
    MSYS2_ARG_CONV_EXCL: "*",
  };
  for (const name of [
    "CI",
    "WAIT",
    "EXPECT_OUTPUT",
    "REDIRECT_STDERR",
    "LUMINE_TEST_RELEASE",
    "LUMINE_TEST_SEED",
    "LUMINE_TEST_EXIT",
    "LUMINE_TEST_OPEN_EXIT",
    "LUMINE_TEST_KEEPALIVE",
    "LUMINE_TEST_PROBE_EXITED",
    "LUMINE_TEST_READ_STDIN",
  ]) {
    delete env[name];
  }
  const launch = (args, options = {}) => {
    const shellArgs = [
      "-c",
      'export PATH="$LUMINE_TEST_BIN:$PATH"; exec bash "$LUMINE_TEST_SCRIPT" "$@"',
      "launcher-test",
      ...args,
    ];
    return (options.async ? spawn : spawnSync)(bash, shellArgs, {
      cwd,
      env,
      encoding: "utf8",
      timeout: options.async ? undefined : 10000,
      ...options,
    });
  };
  return {
    directory,
    env,
    launch,
    report: () => JSON.parse(fs.readFileSync(env.LUMINE_TEST_REPORT, "utf8")),
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
    test(`${platform} classifies options in ${JSON.stringify(args)}`, (t) => {
      const f = fixture(t, platform);
      const result = f.launch(args);
      const options = parseOptions(args);
      assert.equal(
        result.status,
        options.add && options["new-window"] && !options.help && !options.version ? 1 : 0,
        result.stderr,
      );
      assert.match(result.stdout, /launcher probe/);
      assert.deepEqual(f.report().argv.slice(platform === "Linux" ? 3 : 2), args);
      assert.equal(f.report().homeExisted, false);
    });
  }

  test(`${platform} leaves literal arguments intact after --`, (t) => {
    const f = fixture(t, platform);
    const args = ["-f", "--", "--wait", "--new-window", "-notes.txt", "", "file with spaces"];
    const result = f.launch(args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parseOptions(f.report().argv)._, args.slice(2));
  });

  test(`${platform} lets core seed a fresh configuration directory`, (t) => {
    const f = fixture(t, platform);
    f.env.LUMINE_TEST_SEED = "1";
    const result = f.launch(["project", "-f"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.report().homeExisted, false);
    assert.equal(f.report().seeded, true);
  });

  test(`${platform} derives the default config name from a script path with spaces`, (t) => {
    const f = fixture(t, platform);
    delete f.env.LUMINE_HOME;
    const result = f.launch(["-f"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(shellPath(f.report().home), `${shellPath(f.directory)}/.lumine`);
  });

  test(`${platform} preserves input for --foreground with --wait`, (t) => {
    const f = fixture(t, platform);
    f.env.LUMINE_TEST_READ_STDIN = "1";
    f.env.LUMINE_TEST_EXIT = "7";
    const result = f.launch(["--wait", "-f"], { input: "launcher input\n" });
    assert.equal(result.status, 7, result.stderr);
    assert.equal(f.report().input, "launcher input\n");
  });

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
    test(`${platform} does not foreground disabled or literal options in ${JSON.stringify(args)}`, (t) => {
      const f = fixture(t, platform);
      const result = f.launch(args);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.deepEqual(parseOptions(f.report().argv)._, parseOptions(args)._);
    });
  }
}

test("Darwin resolves a relative launcher symlink from an unrelated project", (t) => {
  const f = fixture(t, "Darwin");
  const link = path.join(f.directory, "bin", "lumine");
  const source = path.join(
    f.directory,
    "Editor Apps",
    "Lumine",
    "Lumine.app",
    "Contents",
    "Resources",
    "lumine.sh",
  );
  try {
    fs.symlinkSync(path.relative(path.dirname(link), source), link, "file");
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
    t.skip("Windows does not allow native file symlinks for this account");
    return;
  }
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  f.env.LUMINE_TEST_SCRIPT = shellPath(link);
  const result = f.launch(["-f", "project"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /launcher probe/);
});

for (const args of [[], ["--wait"]]) {
  test(`Linux rejects a missing executable before launch for ${JSON.stringify(args)}`, (t) => {
    const f = fixture(t);
    f.env.LUMINE_PATH = shellPath(path.join(f.directory, "missing"));
    const result = f.launch(args);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Cannot execute/);
    assert.equal(fs.existsSync(f.env.LUMINE_TEST_REPORT), false);
    assert.equal(
      fs.readdirSync(f.directory).some((name) => name.startsWith("lumine-wait.")),
      false,
    );
  });

  test(
    `Linux rejects a non-executable binary for ${JSON.stringify(args)}`,
    { skip: process.platform === "win32" && "Windows does not enforce POSIX executable mode" },
    (t) => {
      const f = fixture(t);
      fs.chmodSync(path.join(f.directory, "Editor Apps", "Lumine", "lumine"), 0o644);
      const result = f.launch(args);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Cannot execute/);
      assert.equal(fs.existsSync(f.env.LUMINE_TEST_REPORT), false);
    },
  );

  test(`Darwin returns an open failure for ${JSON.stringify(args)}`, (t) => {
    const f = fixture(t, "Darwin");
    f.env.LUMINE_TEST_OPEN_EXIT = "9";
    const result = f.launch(args);
    assert.equal(result.status, 9, result.stderr);
    assert.equal(fs.existsSync(f.env.LUMINE_TEST_REPORT), false);
    assert.equal(
      fs.readdirSync(f.directory).some((name) => name.startsWith("lumine-wait.")),
      false,
    );
  });
}

for (const args of [[], ["project", "--wait"]]) {
  test(`Linux propagates native failure according to wait mode for ${JSON.stringify(args)}`, (t) => {
    const f = fixture(t);
    f.env.LUMINE_TEST_EXIT = "7";
    const result = f.launch(args);
    assert.equal(result.status, args.includes("--wait") ? 7 : 0, result.stderr);
    assert.match(result.stdout, /launcher probe/);
    assert.equal(f.report().homeExisted, false);
    assert.equal(
      fs.readdirSync(f.directory).some((name) => name.startsWith("lumine-wait.")),
      false,
    );
  });
}

function reportReady(filePath) {
  let watcher;
  const ready = new Promise((resolve, reject) => {
    const check = () => {
      if (!fs.existsSync(filePath)) return;
      watcher.close();
      resolve();
    };
    watcher = fs.watch(path.dirname(filePath), check);
    watcher.once("error", reject);
    check();
  });
  return { ready, close: () => watcher.close() };
}

function outputCleaned(directory) {
  let watcher;
  const ready = new Promise((resolve, reject) => {
    const check = () => {
      if (fs.readdirSync(directory).some((name) => name.startsWith("lumine-output."))) return;
      watcher.close();
      resolve();
    };
    watcher = fs.watch(directory, check);
    watcher.once("error", reject);
    check();
  });
  return { ready, close: () => watcher.close() };
}

test(
  "Linux detached launches preserve fresh config and literal options",
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t);
    f.env.LUMINE_TEST_SEED = "1";
    const marker = reportReady(f.env.LUMINE_TEST_REPORT);
    t.after(marker.close);
    const child = f.launch(["--wait", "--no-wait", "--", "--help"], {
      async: true,
      stdio: "ignore",
    });
    const closed = once(child, "close");
    await marker.ready;
    assert.deepEqual(await closed, [0, null]);
    assert.equal(f.report().homeExisted, false);
    assert.equal(f.report().seeded, true);
    assert.deepEqual(parseOptions(f.report().argv)._, ["--help"]);
  },
);

for (const platform of ["Linux", "Darwin"]) {
  test(
    `${platform} --wait after a path lasts until the probe releases it`,
    { timeout: 15000 },
    async (t) => {
      const f = fixture(t, platform);
      f.env.LUMINE_TEST_RELEASE = path.join(f.directory, "release");
      const marker = reportReady(f.env.LUMINE_TEST_REPORT);
      t.after(marker.close);
      const child = f.launch(["project", "--wait"], { async: true, stdio: "ignore" });
      const closed = once(child, "close");
      t.after(() => {
        if (child.exitCode === null) child.kill();
      });
      await marker.ready;
      assert.equal(child.exitCode, null);
      assert.equal(f.report().homeExisted, false);
      fs.writeFileSync(f.env.LUMINE_TEST_RELEASE, "release\n");
      assert.deepEqual(await closed, [0, null]);
    },
  );

  test(
    `${platform} --wait with output releases while the native application remains alive`,
    { timeout: 15000 },
    async (t) => {
      const f = fixture(t, platform);
      f.env.LUMINE_TEST_RELEASE = path.join(f.directory, "release");
      f.env.LUMINE_TEST_KEEPALIVE = path.join(f.directory, "stop-probe");
      f.env.LUMINE_TEST_PROBE_EXITED = path.join(f.directory, "probe-exited");
      const marker = reportReady(f.env.LUMINE_TEST_REPORT);
      t.after(marker.close);
      const child = f.launch(["project", "--wait", "-f"], { async: true, stdio: "ignore" });
      const closed = once(child, "close");
      t.after(() => {
        if (child.exitCode === null) child.kill();
        if (fs.existsSync(f.directory)) fs.writeFileSync(f.env.LUMINE_TEST_KEEPALIVE, "stop\n");
      });
      await marker.ready;
      fs.writeFileSync(f.env.LUMINE_TEST_RELEASE, "release\n");
      assert.deepEqual(await closed, [0, null]);
      assert.equal(fs.existsSync(f.env.LUMINE_TEST_PROBE_EXITED), false);
      const exited = reportReady(f.env.LUMINE_TEST_PROBE_EXITED);
      t.after(exited.close);
      fs.writeFileSync(f.env.LUMINE_TEST_KEEPALIVE, "stop\n");
      await exited.ready;
    },
  );
}

test(
  "Linux wait failure cleanup completes after the waiting shell exits",
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t);
    f.env.LUMINE_TEST_RELEASE = path.join(f.directory, "release");
    f.env.LUMINE_TEST_EXIT = "7";
    const marker = reportReady(f.env.LUMINE_TEST_REPORT);
    t.after(marker.close);
    const child = f.launch(["project", "--wait"], { async: true, stdio: "ignore" });
    const closed = once(child, "close");
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    await marker.ready;
    const cleaned = outputCleaned(f.directory);
    t.after(cleaned.close);
    fs.writeFileSync(f.env.LUMINE_TEST_RELEASE, "release\n");
    assert.deepEqual(await closed, [0, null]);
    await cleaned.ready;
  },
);
