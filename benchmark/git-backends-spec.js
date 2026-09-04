const ChildProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const gitUtils = require("@lumine-code/git-utils");
const GitCliBackend = require("../src/git-cli-backend");
const GitRunner = require("../src/git-runner");
const GitUtilsBackend = require("../src/git-utils-backend");

const RUNS = positiveInteger(process.env.LUMINE_GIT_BENCHMARK_RUNS, 7);
const WARMUPS = positiveInteger(process.env.LUMINE_GIT_BENCHMARK_WARMUPS, 2);
const LARGE_TRACKED = positiveInteger(process.env.LUMINE_GIT_BENCHMARK_LARGE_TRACKED, 2500);
const LARGE_STAGED = positiveInteger(process.env.LUMINE_GIT_BENCHMARK_LARGE_STAGED, 300);
const LARGE_UNSTAGED = positiveInteger(process.env.LUMINE_GIT_BENCHMARK_LARGE_UNSTAGED, 700);
const LARGE_UNTRACKED = positiveInteger(process.env.LUMINE_GIT_BENCHMARK_LARGE_UNTRACKED, 500);
const MAX_DIFF_BYTES = 64 * 1024 * 1024;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function runGit(workingDirectory, args) {
  const result = ChildProcess.spawnSync("git", args, {
    cwd: workingDirectory,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return String(result.stdout).trim();
}

function writeFiles(root, directory, count, content) {
  const target = path.join(root, directory);
  fs.mkdirSync(target, { recursive: true });
  for (let index = 0; index < count; index++) {
    const name = `${String(index).padStart(6, "0")}.txt`;
    fs.writeFileSync(path.join(target, name), content(index));
  }
}

function makeWritable(target) {
  let stats;
  try {
    stats = fs.lstatSync(target);
  } catch {
    return;
  }
  try {
    fs.chmodSync(target, 0o700);
  } catch {
    // The retry below will surface a real access failure.
  }
  if (stats.isDirectory()) {
    for (const entry of fs.readdirSync(target)) makeWritable(path.join(target, entry));
  }
}

function removeFixtureRoot(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
    makeWritable(target);
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function createFixture(parent, name, shape) {
  const workingDirectory = fs.realpathSync.native(path.join(parent, name));
  runGit(workingDirectory, ["init", "--initial-branch=main"]);
  runGit(workingDirectory, ["config", "user.name", "Lumine Git Benchmark"]);
  runGit(workingDirectory, ["config", "user.email", "benchmark@lumine.invalid"]);
  runGit(workingDirectory, ["config", "core.autocrlf", "false"]);
  runGit(workingDirectory, ["config", "commit.gpgSign", "false"]);

  const changed = shape.staged + shape.unstaged;
  const stable = Math.max(0, shape.tracked - changed);
  writeFiles(workingDirectory, "tracked/staged", shape.staged, (index) => `base staged ${index}\n`);
  writeFiles(
    workingDirectory,
    "tracked/unstaged",
    shape.unstaged,
    (index) => `base unstaged ${index}\n`,
  );
  writeFiles(workingDirectory, "tracked/stable", stable, (index) => `base stable ${index}\n`);
  runGit(workingDirectory, ["add", "."]);
  runGit(workingDirectory, ["commit", "--no-gpg-sign", "-m", `${name} fixture`]);

  writeFiles(
    workingDirectory,
    "tracked/staged",
    shape.staged,
    (index) => `changed staged ${index}\nsecond line\n`,
  );
  if (shape.staged > 0) runGit(workingDirectory, ["add", "tracked/staged"]);
  writeFiles(
    workingDirectory,
    "tracked/unstaged",
    shape.unstaged,
    (index) => `changed unstaged ${index}\nsecond line\n`,
  );
  writeFiles(workingDirectory, "untracked", shape.untracked, (index) => `untracked ${index}\n`);

  return {
    name,
    shape,
    workingDirectory,
    descriptor: {
      gitDirectory: fs.realpathSync.native(path.join(workingDirectory, ".git")),
      workingDirectory,
      hasSubmodules: false,
      submodulePaths: [],
    },
  };
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function round(value) {
  return Number(value.toFixed(3));
}

function summarize(samples) {
  return {
    medianMs: round(percentile(samples, 0.5)),
    p95Ms: round(percentile(samples, 0.95)),
    minMs: round(Math.min(...samples)),
    maxMs: round(Math.max(...samples)),
    samplesMs: samples.map(round),
  };
}

async function timed(operation) {
  const start = performance.now();
  await operation();
  return performance.now() - start;
}

async function measurePair(gitUtilsOperation, systemGitOperation) {
  for (let index = 0; index < WARMUPS; index++) {
    if (index % 2 === 0) {
      await gitUtilsOperation();
      await systemGitOperation();
    } else {
      await systemGitOperation();
      await gitUtilsOperation();
    }
  }

  const gitUtilsSamples = [];
  const systemGitSamples = [];
  for (let index = 0; index < RUNS; index++) {
    if (index % 2 === 0) {
      gitUtilsSamples.push(await timed(gitUtilsOperation));
      systemGitSamples.push(await timed(systemGitOperation));
    } else {
      systemGitSamples.push(await timed(systemGitOperation));
      gitUtilsSamples.push(await timed(gitUtilsOperation));
    }
  }

  const gitUtilsSummary = summarize(gitUtilsSamples);
  const systemGitSummary = summarize(systemGitSamples);
  return {
    gitUtils: gitUtilsSummary,
    systemGit: systemGitSummary,
    ratio: {
      median: round(gitUtilsSummary.medianMs / systemGitSummary.medianMs),
      p95: round(gitUtilsSummary.p95Ms / systemGitSummary.p95Ms),
    },
  };
}

function comparableStatus(snapshot) {
  const { generation: _generation, ...value } = snapshot;
  return value;
}

async function benchmarkFixture(fixture, backends) {
  const statusRequest = {
    status: true,
    refs: false,
    includeIgnored: false,
    generations: { status: 1 },
  };
  const diffRequest = {
    from: { type: "commit", revision: "HEAD" },
    to: { type: "worktree" },
    context: 3,
    detectRenames: true,
    ignoreWhitespace: false,
    format: "structured",
    maxBytes: MAX_DIFF_BYTES,
  };

  const gitUtilsStatus = () => backends.gitUtils.snapshot(fixture.descriptor, statusRequest);
  const systemGitStatus = () => backends.cli.snapshot(fixture.descriptor, statusRequest);
  const refsRequest = { status: false, refs: true, generations: { refs: 1 } };
  const gitUtilsRefs = () => backends.gitUtils.snapshot(fixture.descriptor, refsRequest);
  const systemGitRefs = () => backends.cli.snapshot(fixture.descriptor, refsRequest);
  const gitUtilsDiff = () => backends.gitUtils.diff(fixture.descriptor, diffRequest);
  const systemGitDiff = () =>
    backends.cli.diff(fixture.descriptor, diffRequest, { maxBytes: MAX_DIFF_BYTES });
  const configKeys = ["core.repositoryformatversion", "core.bare", "user.name"];
  const gitUtilsConfig = () => backends.gitUtils.readConfig(fixture.descriptor, configKeys);
  const systemGitConfig = () => backends.cli.readConfig(fixture.descriptor, configKeys);
  const stableCount = Math.max(
    0,
    fixture.shape.tracked - fixture.shape.staged - fixture.shape.unstaged,
  );
  const objectDirectory = stableCount > 0 ? "tracked/stable" : "tracked/staged";
  const objectCount = Math.min(10, Math.max(stableCount, fixture.shape.staged));
  const objectRequests = Array.from({ length: objectCount }, (_, index) => ({
    revision: "HEAD",
    path: `${objectDirectory}/${String(index).padStart(6, "0")}.txt`,
  }));
  const gitUtilsObjects = () => backends.gitUtils.readObjects(fixture.descriptor, objectRequests);
  const systemGitObjects = () => backends.cli.readObjects(fixture.descriptor, objectRequests);
  const historyRequest = { revision: "HEAD", limit: 50, skip: 0 };
  const gitUtilsHistory = () => backends.gitUtils.history(fixture.descriptor, historyRequest);
  const systemGitHistory = () => backends.cli.history(fixture.descriptor, historyRequest);
  const blameRequest = {
    revision: "HEAD",
    path: `${objectDirectory}/000000.txt`,
    ignoreWhitespace: false,
  };
  const gitUtilsBlame = () => backends.gitUtils.blame(fixture.descriptor, blameRequest);
  const systemGitBlame = () => backends.cli.blame(fixture.descriptor, blameRequest);
  const oldLines = Buffer.from(
    Array.from({ length: 2000 }, (_, index) => `line ${index}`).join("\n"),
  );
  const newLines = `${oldLines.toString("utf8")}\nchanged\n`;
  const gitUtilsLineDiff = () => gitUtils.lineDiff(oldLines, newLines);
  const systemGitLineDiff = () => backends.cli.lineDiff(oldLines, newLines);

  const [
    nativeStatus,
    cliStatus,
    nativeRefs,
    cliRefs,
    nativeDiff,
    cliDiff,
    nativeConfig,
    cliConfig,
    nativeObjects,
    cliObjects,
    nativeHistory,
    cliHistory,
    nativeBlame,
    cliBlame,
    nativeLineDiff,
    cliLineDiff,
  ] = await Promise.all([
    gitUtilsStatus(),
    systemGitStatus(),
    gitUtilsRefs(),
    systemGitRefs(),
    gitUtilsDiff(),
    systemGitDiff(),
    gitUtilsConfig(),
    systemGitConfig(),
    gitUtilsObjects(),
    systemGitObjects(),
    gitUtilsHistory(),
    systemGitHistory(),
    gitUtilsBlame(),
    systemGitBlame(),
    gitUtilsLineDiff(),
    systemGitLineDiff(),
  ]);
  expect(comparableStatus(nativeStatus.status.value)).toEqual(
    comparableStatus(cliStatus.status.value),
  );
  expect(comparableStatus(nativeRefs.refs.value)).toEqual(comparableStatus(cliRefs.refs.value));
  expect(nativeDiff).toEqual(cliDiff);
  expect(nativeConfig).toEqual(cliConfig);
  expect(nativeObjects).toEqual(cliObjects);
  expect(nativeHistory).toEqual(cliHistory);
  expect(nativeBlame).toEqual(cliBlame);
  expect(nativeLineDiff).toEqual(cliLineDiff);

  return {
    input: fixture.shape,
    checks: {
      statusFiles: nativeStatus.status.value.files.length,
      diffFiles: nativeDiff.files.length,
    },
    statusSnapshot: await measurePair(gitUtilsStatus, systemGitStatus),
    refsSnapshot: await measurePair(gitUtilsRefs, systemGitRefs),
    worktreeDiff: await measurePair(gitUtilsDiff, systemGitDiff),
    configRead: await measurePair(gitUtilsConfig, systemGitConfig),
    objectRead: await measurePair(gitUtilsObjects, systemGitObjects),
    history: await measurePair(gitUtilsHistory, systemGitHistory),
    blame: await measurePair(gitUtilsBlame, systemGitBlame),
    lineDiff: await measurePair(gitUtilsLineDiff, systemGitLineDiff),
  };
}

describe("Git backend benchmark", () => {
  it(
    "compares git-utils and system Git on clean, dirty, and large repositories",
    async () => {
      jasmine.useRealClock();
      gitUtils.configure({ validateOwnership: false });

      const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-git-backends-"));
      const runner = new GitRunner({ trustAllRepositories: true });
      const backends = {
        gitUtils: new GitUtilsBackend({ nativeBackend: gitUtils }),
        cli: new GitCliBackend({ runner }),
      };
      const shapes = {
        clean: { tracked: 50, staged: 0, unstaged: 0, untracked: 0 },
        dirty: { tracked: 200, staged: 30, unstaged: 70, untracked: 50 },
        large: {
          tracked: LARGE_TRACKED,
          staged: Math.min(LARGE_STAGED, LARGE_TRACKED),
          unstaged: Math.min(LARGE_UNSTAGED, Math.max(0, LARGE_TRACKED - LARGE_STAGED)),
          untracked: LARGE_UNTRACKED,
        },
      };

      try {
        const scenarios = {};
        for (const [name, shape] of Object.entries(shapes)) {
          const directory = path.join(fixtureRoot, name);
          fs.mkdirSync(directory);
          const fixture = createFixture(fixtureRoot, name, shape);
          scenarios[name] = await benchmarkFixture(fixture, backends);
        }

        console.log(
          `GIT_BACKENDS_BENCHMARK=${JSON.stringify({
            runtime: {
              electron: process.versions.electron,
              node: process.versions.node,
              platform: process.platform,
              arch: process.arch,
              git: runGit(fixtureRoot, ["--version"]),
              gitUtils: gitUtils.versions(),
            },
            input: {
              runs: RUNS,
              warmups: WARMUPS,
              ratio: "gitUtils/systemGit; values below 1 favor git-utils",
            },
            scenarios,
          })}`,
        );
      } finally {
        removeFixtureRoot(fixtureRoot);
      }
    },
    10 * 60 * 1000,
  );
});
