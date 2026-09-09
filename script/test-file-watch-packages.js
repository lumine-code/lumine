// Acceptance validation for the file-watch migration. Each pinned package gets
// its own checkout, dependency tree, Lumine home and Electron spec process.
// Run after npm ci and npm run build in core. An optional --package <name>
// restricts a local diagnostic run; the manual CI workflow always runs the set.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const coreDirectory = path.resolve(__dirname, "..");
const packages = require("./file-watch-packages.json");
const TIMEOUT_MS = 10 * 60 * 1000;
const NAME = /^[a-z0-9][a-z0-9-]*$/;

function run(command, args, { cwd, env, logPath, shell = false }) {
  return new Promise((resolve, reject) => {
    const log = fs.createWriteStream(logPath, { flags: "a" });
    const child = spawn(command, args, {
      cwd,
      env,
      shell,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    let spawnError;
    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the process tree, including an Electron renderer or a compiler,
      // before the next package starts. Never retry a spec process.
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") child.kill("SIGKILL");
        }
      }
    }, TIMEOUT_MS);
    for (const output of [child.stdout, child.stderr]) {
      output.on("data", (chunk) => {
        process.stdout.write(chunk);
        log.write(chunk);
      });
    }
    child.on("error", (error) => {
      spawnError = error;
      clearTimeout(timer);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      log.end(() => {
        if (spawnError) reject(spawnError);
        else if (timedOut) reject(new Error("Process exceeded its 10 minute deadline"));
        else if (code !== 0) reject(new Error(`Process exited ${code ?? signal}`));
        else resolve();
      });
    });
  });
}

async function retryInstall(action) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (attempt === 3) throw error;
      console.warn(`Dependency setup failed (attempt ${attempt}): ${error.message}`);
    }
  }
}

function revision(directory) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: directory,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`Cannot read Git HEAD in ${directory}`);
  return result.stdout.trim();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--package")) {
    throw new Error("Usage: node script/test-file-watch-packages.js [--package <name>]");
  }
  if (packages.length !== 22)
    throw new Error("The migration acceptance set must contain 22 packages");
  const seen = new Set();
  for (const entry of packages) {
    if (!NAME.test(entry.repo) || !/^[a-f0-9]{40}$/.test(entry.sha) || seen.has(entry.repo)) {
      throw new Error(`Invalid or duplicate package pin: ${JSON.stringify(entry)}`);
    }
    seen.add(entry.repo);
  }
  const selected = args.length ? packages.filter((entry) => entry.repo === args[1]) : packages;
  if (!selected.length) throw new Error(`Unknown package: ${args[1]}`);

  const resultsDirectory = path.resolve(
    process.env.FILE_WATCH_PACKAGE_RESULTS ||
      path.join(coreDirectory, ".dev", "file-watch-package-results"),
  );
  fs.mkdirSync(resultsDirectory, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-file-watch-packages-"));
  const report = {
    coreSHA: revision(coreDirectory),
    platform: process.platform,
    arch: process.arch,
    startedAt: new Date().toISOString(),
    completeSet: selected.length === packages.length,
    packages: selected.map((entry) => ({ ...entry, status: "pending" })),
  };
  const saveReport = () =>
    fs.writeFileSync(
      path.join(resultsDirectory, "results.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  saveReport();

  for (const result of report.packages) {
    console.log(`::group::${result.repo} (${result.sha})`);
    const directory = path.join(workspace, result.repo);
    const home = path.join(workspace, "homes", result.repo);
    fs.mkdirSync(directory);
    fs.mkdirSync(home, { recursive: true });
    const logPath = path.join(resultsDirectory, `${result.repo}.log`);
    fs.writeFileSync(logPath, "");
    const options = { cwd: directory, env: { ...process.env }, logPath };
    // Inherited development settings must not load an installed package or a
    // different editor. The test bootstrap uses only this package's spec peers.
    delete options.env.LUMINE_TEST_PACKAGES;
    options.env.LUMINE_HOME = home;
    options.env.LUMINE_RESOURCE_PATH = coreDirectory;
    result.startedAt = new Date().toISOString();
    const phase = (name) => {
      result.phase = name;
      saveReport();
    };
    try {
      phase("checkout");
      await run("git", ["init", "--quiet", directory], options);
      await run(
        "git",
        ["remote", "add", "origin", `https://github.com/lumine-code/${result.repo}.git`],
        options,
      );
      await retryInstall(() =>
        run("git", ["fetch", "--depth", "1", "origin", result.sha], options),
      );
      await run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], options);
      if (revision(directory) !== result.sha)
        throw new Error("Checkout does not match the pinned SHA");
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
      if (manifest.name !== result.repo || !fs.existsSync(path.join(directory, "spec"))) {
        throw new Error("Checkout must contain the named package and its spec directory");
      }

      phase("install");
      // Only fixed arguments enter shell mode, which is required for npm.cmd.
      await retryInstall(() =>
        run("npm ci --ignore-scripts --no-audit --no-fund", [], { ...options, shell: true }),
      );
      if (
        result.repo === "symbol-ctags" ||
        (result.repo === "native-clip" && process.platform !== "linux")
      ) {
        phase("native-build");
        await run(
          process.execPath,
          [
            path.join(coreDirectory, "node_modules", "@electron", "rebuild", "lib", "cli.js"),
            "--version",
            require("../package.json").electronVersion,
            "--module-dir",
            directory,
          ],
          { ...options, cwd: coreDirectory },
        );
      }

      phase("spec-packages");
      await run(
        process.execPath,
        [path.join(__dirname, "install-spec-packages.js"), "--package", directory, "--home", home],
        options,
      );
      const specPackages = manifest.specPackages || [];
      options.env.LUMINE_TEST_PACKAGES = specPackages.join(" ");
      result.specPackages = specPackages.map((repo) => ({
        repo,
        sha: revision(path.join(home, "packages", repo)),
      }));

      phase("specs");
      const electron = require("electron");
      const electronArgs = [
        "--no-sandbox",
        "--enable-logging",
        ".",
        "-f",
        "--dev",
        "--test",
        path.join(directory, "spec"),
      ];
      const specOptions = { ...options, cwd: coreDirectory };
      if (process.platform === "linux") {
        await run("xvfb-run", ["--auto-servernum", electron, ...electronArgs], specOptions);
      } else {
        await run(electron, electronArgs, specOptions);
      }
      const output = fs.readFileSync(logPath, "utf8");
      const summary = [...output.matchAll(/(\d+) specs?, (\d+) failures?/g)].at(-1);
      if (!summary || Number(summary[1]) === 0 || Number(summary[2]) !== 0) {
        throw new Error("Electron did not report a completed, passing spec suite");
      }
      result.specCount = Number(summary[1]);
      result.status = "passed";
    } catch (error) {
      result.status = "failed";
      result.error = error.message;
      console.error(`::error::${result.repo} ${result.phase}: ${error.message}`);
    } finally {
      result.finishedAt = new Date().toISOString();
      if (result.phase === "specs") {
        const output = fs.readFileSync(logPath, "utf8");
        const summary = [...output.matchAll(/(\d+) specs?, (\d+) failures?/g)].at(-1);
        if (summary) {
          result.specCount = Number(summary[1]);
          result.failureCount = Number(summary[2]);
        }
      }
      const crashes = path.join(home, "crashdumps");
      if (fs.existsSync(crashes)) {
        fs.cpSync(crashes, path.join(resultsDirectory, `${result.repo}-crashdumps`), {
          recursive: true,
        });
      }
      saveReport();
      console.log("::endgroup::");
    }
  }

  report.finishedAt = new Date().toISOString();
  saveReport();
  const rows = report.packages.map(
    (entry) =>
      `| ${entry.repo} | ${entry.sha} | ${entry.status} | ${entry.specCount ?? "—"} | ${entry.error || ""} |`,
  );
  const summary = [
    `Package specs on ${report.platform} (${report.arch}), core ${report.coreSHA}.`,
    "",
    "| Package | SHA | Result | Specs | Error |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(resultsDirectory, "summary.md"), summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
  process.exitCode = report.packages.every((entry) => entry.status === "passed") ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
