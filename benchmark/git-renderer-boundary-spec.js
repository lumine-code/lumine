const fs = require("fs");
const os = require("os");
const path = require("path");
const ChildProcess = require("child_process");

const GitHost = require("../src/git-host");
const CoreGitRepository = require("../src/git-repository");
const { discoverRepositoryDescriptor } = require("../src/git-repository-descriptor");

class GitRepository extends CoreGitRepository {
  constructor(filePath, options) {
    super(discoverRepositoryDescriptor(filePath), options);
  }
}

const RUNS = Number(process.env.LUMINE_GIT_RENDERER_BENCHMARK_RUNS || 3);
const STATUS_SIZES = (process.env.LUMINE_GIT_RENDERER_STATUS_SIZES || "1000,10000,50000")
  .split(",")
  .map(Number)
  .filter((value) => Number.isFinite(value) && value > 0);
const DEEP_STATUS_DEPTHS = (process.env.LUMINE_GIT_RENDERER_STATUS_DEPTHS || "1000,5000")
  .split(",")
  .map(Number)
  .filter((value) => Number.isFinite(value) && value > 0);
const REFS_SIZES = (process.env.LUMINE_GIT_RENDERER_REFS_SIZES || "1000,10000,50000")
  .split(",")
  .map(Number)
  .filter((value) => Number.isFinite(value) && value > 0);
const IPC_STATUS_SIZES = (process.env.LUMINE_GIT_RENDERER_IPC_STATUS_SIZES || "10000,50000")
  .split(",")
  .map(Number)
  .filter((value) => Number.isFinite(value) && value > 0)
  .sort((left, right) => left - right);
const FRAME_BUDGET_MS = 16;

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(samples) {
  return {
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
    samplesMs: samples,
  };
}

async function observeEventLoop(run) {
  let active = true;
  let maximumGap = 0;
  let previous = performance.now();
  const tick = () => {
    const now = performance.now();
    maximumGap = Math.max(maximumGap, now - previous);
    previous = now;
    if (active) setImmediate(tick);
  };
  setImmediate(tick);
  await new Promise((resolve) => setImmediate(resolve));
  const start = performance.now();
  await run();
  const total = performance.now() - start;
  active = false;
  await new Promise((resolve) => setImmediate(resolve));
  return { totalMs: total, maxEventLoopGapMs: maximumGap };
}

function statusValue(count, generation) {
  const files = Array.from({ length: count }, (_, index) => ({
    path: `directory-${index % 100}/nested/file-${index}.txt`,
    originalPath: null,
    kind: "untracked",
    indexStatus: null,
    worktreeStatus: null,
    staged: false,
    unstaged: true,
    conflicted: false,
    untracked: true,
    ignored: false,
    similarity: null,
    submodule: {
      isSubmodule: false,
      commitChanged: false,
      modified: false,
      hasUntrackedChanges: false,
    },
  }));
  return {
    schemaVersion: 1,
    generation,
    initialized: true,
    includesIgnored: true,
    head: { oid: "a".repeat(40), name: "main", detached: false, unborn: false },
    upstream: null,
    files,
    counts: {
      total: count,
      staged: 0,
      unstaged: count,
      conflicted: 0,
      untracked: count,
      ignored: 0,
    },
  };
}

function deepStatusValue(depth, generation) {
  const value = statusValue(0, generation);
  value.files = [
    {
      path: `${Array.from({ length: depth }, () => "nested").join("/")}/file.txt`,
      originalPath: null,
      kind: "untracked",
      indexStatus: null,
      worktreeStatus: null,
      staged: false,
      unstaged: true,
      conflicted: false,
      untracked: true,
      ignored: false,
      similarity: null,
      submodule: {
        isSubmodule: false,
        commitChanged: false,
        modified: false,
        hasUntrackedChanges: false,
      },
    },
  ];
  value.counts = {
    total: 1,
    staged: 0,
    unstaged: 1,
    conflicted: 0,
    untracked: 1,
    ignored: 0,
  };
  return value;
}

function refsValue(count, generation) {
  const oid = "a".repeat(40);
  return {
    schemaVersion: 1,
    generation,
    initialized: true,
    head: {
      oid,
      ref: "refs/heads/branch-0",
      name: "branch-0",
      detached: false,
      unborn: false,
    },
    branches: Array.from({ length: count }, (_, index) => ({
      name: `branch-${index}`,
      ref: `refs/heads/branch-${index}`,
      oid,
      isHead: index === 0,
      upstream: null,
      push: null,
      lastCommit: {
        oid,
        parents: [],
        authorName: "Lumine",
        committerDate: new Date(0),
        subject: `Commit ${index}`,
      },
    })),
    remoteBranches: [],
    tags: [],
    remotes: [],
    worktrees: [],
  };
}

function runGitSync(workingDirectory, args, input = undefined) {
  const result = ChildProcess.spawnSync("git", args, {
    cwd: workingDirectory,
    input,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function createIpcStatusFixture() {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-git-ipc-benchmark-"));
  runGitSync(workingDirectory, ["init", "--quiet"]);
  const emptyOid = runGitSync(workingDirectory, ["hash-object", "--stdin"], "");
  let entryCount = 0;
  return {
    descriptor: discoverRepositoryDescriptor(workingDirectory),
    addEntries(targetCount) {
      const records = [];
      for (let index = entryCount; index < targetCount; index++) {
        records.push(`100644 ${emptyOid}\tbenchmark/file-${String(index).padStart(6, "0")}.txt\n`);
      }
      runGitSync(
        workingDirectory,
        ["update-index", "--info-only", "--index-info"],
        records.join(""),
      );
      entryCount = targetCount;
    },
    destroy() {
      fs.rmSync(workingDirectory, {
        recursive: true,
        force: true,
        maxRetries: process.platform === "win32" ? 20 : 0,
        retryDelay: 50,
      });
    },
  };
}

describe("Git renderer boundary benchmark", () => {
  it("measures worker line diff and time-sliced renderer snapshot indexing", async () => {
    jasmine.useRealClock();
    GitHost.reset();
    GitHost.setForkModeForTesting(true);
    GitHost.setChildFactoryForTesting(null);
    const repository = new GitRepository(process.cwd());
    let ipcStatusFixture = null;

    try {
      await repository.refreshStatusSnapshot();
      const packagePath = path.join(process.cwd(), "package.json");
      const original = fs.readFileSync(packagePath, "utf8");
      const largeText = `${original}\n${Array.from(
        { length: 20000 },
        (_, index) => `line-${index}: ${"x".repeat(24)}`,
      ).join("\n")}`;
      await repository.getLineDiffsAsync(packagePath, largeText);

      const lineDiffSamples = [];
      for (let run = 0; run < RUNS; run++) {
        lineDiffSamples.push(
          await observeEventLoop(() => repository.getLineDiffsAsync(packagePath, largeText)),
        );
      }

      const objectIpcMetrics = {};
      const objectDescriptor = discoverRepositoryDescriptor(process.cwd());
      for (const input of [
        {
          name: "buffer",
          path: "resources/brand/loader.gif",
          encoding: "buffer",
        },
        { name: "string", path: "spec/helpers/words.js", encoding: "utf8" },
      ]) {
        const request = () =>
          GitHost.instance().request("readObjects", {
            descriptor: objectDescriptor,
            requests: [{ revision: "HEAD", path: input.path }],
            encoding: input.encoding,
          });
        await request();
        const samples = [];
        let receivedBytes = 0;
        for (let run = 0; run < RUNS; run++) {
          samples.push(
            await observeEventLoop(async () => {
              const [object] = await request();
              receivedBytes = Buffer.isBuffer(object.content)
                ? object.content.length
                : Buffer.byteLength(object.content);
            }),
          );
        }
        const gaps = samples.map(({ maxEventLoopGapMs }) => maxEventLoopGapMs);
        objectIpcMetrics[input.name] = {
          path: input.path,
          receivedBytes,
          total: summarize(samples.map(({ totalMs }) => totalMs)),
          maxEventLoopGap: summarize(gaps),
          frameBudgetMs: FRAME_BUDGET_MS,
          exceededFrameBudget: Math.max(...gaps) > FRAME_BUDGET_MS,
        };
      }

      ipcStatusFixture = createIpcStatusFixture();
      const ipcStatusMetrics = {};
      let ipcGeneration = 1;
      for (const count of IPC_STATUS_SIZES) {
        ipcStatusFixture.addEntries(count);
        const request = () =>
          GitHost.instance().request("snapshot", {
            descriptor: ipcStatusFixture.descriptor,
            request: {
              status: true,
              refs: false,
              generations: { status: ipcGeneration++ },
            },
            options: { maxBuffer: 128 * 1024 * 1024 },
          });
        await request();

        const samples = [];
        let receivedCount = 0;
        for (let run = 0; run < RUNS; run++) {
          samples.push(
            await observeEventLoop(async () => {
              const result = await request();
              receivedCount = result.status.value.files.length;
            }),
          );
        }
        expect(receivedCount).toBe(count);
        const gaps = samples.map(({ maxEventLoopGapMs }) => maxEventLoopGapMs);
        ipcStatusMetrics[count] = {
          total: summarize(samples.map(({ totalMs }) => totalMs)),
          maxEventLoopGap: summarize(gaps),
          frameBudgetMs: FRAME_BUDGET_MS,
          exceededFrameBudget: Math.max(...gaps) > FRAME_BUDGET_MS,
        };
      }
      const statusMetrics = {};
      for (const count of STATUS_SIZES) {
        const samples = [];
        for (let run = 0; run < RUNS; run++) {
          const value = statusValue(count, run + 1);
          samples.push(
            await observeEventLoop(() =>
              repository.applyStatusSnapshotSection(
                { fingerprint: `${count}-${run}`, unchanged: false, value },
                new AbortController().signal,
              ),
            ),
          );
        }
        statusMetrics[count] = {
          total: summarize(samples.map(({ totalMs }) => totalMs)),
          maxEventLoopGap: summarize(samples.map(({ maxEventLoopGapMs }) => maxEventLoopGapMs)),
        };
      }

      const deepStatusMetrics = {};
      for (const depth of DEEP_STATUS_DEPTHS) {
        const samples = [];
        for (let run = 0; run < RUNS; run++) {
          const value = deepStatusValue(depth, run + 1);
          samples.push(
            await observeEventLoop(() =>
              repository.applyStatusSnapshotSection(
                { fingerprint: `deep-${depth}-${run}`, unchanged: false, value },
                new AbortController().signal,
              ),
            ),
          );
        }
        deepStatusMetrics[depth] = {
          total: summarize(samples.map(({ totalMs }) => totalMs)),
          maxEventLoopGap: summarize(samples.map(({ maxEventLoopGapMs }) => maxEventLoopGapMs)),
        };
      }

      const refsMetrics = {};
      for (const count of REFS_SIZES) {
        const samples = [];
        for (let run = 0; run < RUNS; run++) {
          const value = refsValue(count, run + 1);
          samples.push(
            await observeEventLoop(() =>
              repository.applyRefsSnapshotSection(
                { fingerprint: `refs-${count}-${run}`, unchanged: false, value },
                new AbortController().signal,
              ),
            ),
          );
        }
        refsMetrics[count] = {
          total: summarize(samples.map(({ totalMs }) => totalMs)),
          maxEventLoopGap: summarize(samples.map(({ maxEventLoopGapMs }) => maxEventLoopGapMs)),
        };
      }

      console.log(
        `GIT_RENDERER_BENCHMARK_JSON=${JSON.stringify({
          runtime: {
            platform: process.platform,
            arch: process.arch,
            electron: process.versions.electron,
            node: process.versions.node,
          },
          inputs: {
            runs: RUNS,
            lineDiffBytes: Buffer.byteLength(largeText),
            statusEntries: STATUS_SIZES,
            deepStatusDepths: DEEP_STATUS_DEPTHS,
            refsEntries: REFS_SIZES,
            ipcStatusEntries: IPC_STATUS_SIZES,
          },
          metrics: {
            lineDiff: {
              total: summarize(lineDiffSamples.map(({ totalMs }) => totalMs)),
              maxEventLoopGap: summarize(
                lineDiffSamples.map(({ maxEventLoopGapMs }) => maxEventLoopGapMs),
              ),
            },
            statusIndexing: statusMetrics,
            deepStatusIndexing: deepStatusMetrics,
            refsIndexing: refsMetrics,
            snapshotIpc: ipcStatusMetrics,
            objectIpc: objectIpcMetrics,
          },
        })}`,
      );
    } finally {
      repository.destroy();
      GitHost.reset();
      ipcStatusFixture?.destroy();
      GitHost.setForkModeForTesting(null);
    }
  }, 120000);
});
