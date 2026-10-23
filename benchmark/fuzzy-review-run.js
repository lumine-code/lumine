"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");

const workspace = path.resolve(__dirname, "../..");
const core = path.join(workspace, "lumine");
const directory = path.join(workspace, ".dev/fuzzy-performance-review-20261023");
const git = (repo, ...args) =>
  execFileSync("git", ["-C", path.join(workspace, repo), ...args], { windowsHide: true });
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const read = (file) => JSON.parse(fs.readFileSync(file));
const sources = [
  "select-list.js",
  "select-list-model.js",
  "select-list-helpers.js",
  "fuzzy-matcher.js",
  "fuzzy-search-worker.js",
  "fuzzy-search-worker-client.js",
];

function otherTests() {
  if (process.platform !== "win32") return [];
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe','electron.exe') } | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
  const values = JSON.parse(
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
    }) || "[]",
  );
  return (Array.isArray(values) ? values : [values]).filter(
    (value) =>
      value.ProcessId !== process.pid &&
      /--test|benchmark|spec[/\\]/i.test(value.CommandLine || ""),
  );
}

async function quiet(id) {
  const started = Date.now();
  for (;;) {
    const jobs = otherTests();
    fs.appendFileSync(
      path.join(directory, "concurrency-private.jsonl"),
      JSON.stringify({ id, at: new Date().toISOString(), jobs }) + "\n",
    );
    if (!jobs.length) break;
    if (Date.now() - started > 600000)
      throw new Error("Other test jobs did not finish within ten minutes");
    console.log(
      JSON.stringify({ waitingForOtherTests: id, processes: jobs.map((job) => job.ProcessId) }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  const ticks = () =>
    os.cpus().reduce(
      (sum, cpu) => ({
        idle: sum.idle + cpu.times.idle,
        total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
      }),
      { idle: 0, total: 0 },
    );
  const before = ticks();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const after = ticks();
  return {
    waitedMs: Date.now() - started,
    idleFraction: (after.idle - before.idle) / (after.total - before.total),
  };
}

function freeze(label, refs) {
  const target = path.join(directory, label);
  const manifest = { refs: {}, hashes: {} };
  for (const [repo, ref] of Object.entries(refs)) {
    manifest.refs[repo] = git(repo, "rev-parse", ref).toString().trim();
    const files =
      repo === "lumine"
        ? sources.map((name) => `src/${name}`)
        : git(repo, "ls-tree", "-r", "--name-only", ref, "lib").toString().trim().split("\n");
    for (const file of files) {
      const bytes = git(repo, "show", `${ref}:${file}`);
      const destination = path.join(target, repo, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes);
      manifest.hashes[`${repo}/${file}`] = hash(bytes);
    }
  }
  write(path.join(target, "manifest.json"), manifest);
  return manifest;
}

function prepare() {
  fs.mkdirSync(directory, { recursive: true });
  const paths = [];
  const repositories = [];
  for (const entry of fs
    .readdirSync(workspace, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (
      !entry.isDirectory() ||
      entry.name.startsWith(".") ||
      !fs.existsSync(path.join(workspace, entry.name, ".git"))
    )
      continue;
    const files = git(entry.name, "ls-files", "-z").toString().split("\0").filter(Boolean);
    repositories.push({
      repo: entry.name,
      revision: git(entry.name, "rev-parse", "HEAD").toString().trim(),
      count: files.length,
    });
    for (const file of files) paths.push(`${entry.name}/${file}`);
  }
  const project =
    process.platform === "win32"
      ? "C:\\Lumine-fuzzy-benchmark\\project"
      : path.join(os.tmpdir(), "lumine-fuzzy-benchmark/project");
  fs.mkdirSync(project, { recursive: true });
  const activeFile = path.join(project, "copy-000/lumine/src/select-list.js");
  fs.mkdirSync(path.dirname(activeFile), { recursive: true });
  fs.writeFileSync(activeFile, "// Fixed active document for fuzzy performance comparisons.\n");
  const workloads = [];
  for (const count of [100, 30253, 100000, 500000]) {
    const corpus = Array.from({ length: count }, (_, index) =>
      path.join(
        project,
        `copy-${String(Math.floor(index / paths.length)).padStart(3, "0")}`,
        paths[index % paths.length],
      ),
    );
    const corpusFile = path.join(directory, `corpus-${count}.json`);
    write(corpusFile, corpus);
    workloads.push({
      count,
      corpus: corpusFile,
      hash: hash(fs.readFileSync(corpusFile)),
      worker: count !== 100,
    });
  }
  write(path.join(directory, "corpus.json"), {
    project,
    activeFile,
    originalCount: paths.length,
    repositories,
    workloads,
  });
  freeze("before", {
    lumine: "f4bd740393",
    "fuzzy-search": "0ac7a0f8021ff20e751cba2b06af24583d9af76c",
    "fuzzy-files": "174110f",
    "fuzzy-explorer": "f21d4fe",
  });
  freeze("after", {
    lumine: "HEAD",
    "fuzzy-search": "HEAD",
    "fuzzy-files": "HEAD",
    "fuzzy-explorer": "HEAD",
  });
  console.log(
    JSON.stringify({ prepared: directory, count: paths.length, repositories: repositories.length }),
  );
}

async function run(smoke) {
  const corpus = read(path.join(directory, "corpus.json"));
  const electron = require("electron");
  const workloads = smoke ? corpus.workloads.slice(0, 1) : corpus.workloads;
  const runs = [];
  const runOrder = smoke ? ["before", "after"] : ["before", "after", "after", "before"];
  for (const workload of workloads) {
    for (const [index, label] of runOrder.entries()) {
      const id = `${smoke ? "smoke" : "balanced"}-${workload.count}-${index}-${label}`;
      const output = path.join(directory, `${id}.json`);
      const config = {
        label: id,
        snapshot: path.join(directory, label),
        corpus: workload.corpus,
        projectCorpus: workload.corpus,
        project: corpus.project,
        activeFile: corpus.activeFile,
        output,
        packages: ["fuzzy-explorer", "fuzzy-files"],
        queries: ["s", "se", "sel", "se", "s", "", "a", "ab", "a", ""],
        worker: smoke ? true : workload.worker,
        cold: true,
        warmups: smoke ? 0 : 1,
        samples: smoke ? 1 : 3,
      };
      const home = path.join(directory, `${id}-home`);
      fs.mkdirSync(home, { recursive: true });
      const env = {
        ...process.env,
        LUMINE_HOME: home,
        LUMINE_RESOURCE_PATH: core,
        LUMINE_TEST_PACKAGES: "fuzzy-explorer fuzzy-files",
        LUMINE_FUZZY_FLEET: JSON.stringify(config),
      };
      delete env.CI;
      delete env.ELECTRON_RUN_AS_NODE;
      const log = path.join(directory, `${id}.log`);
      const environmentCheck = smoke ? null : await quiet(id);
      const descriptor = fs.openSync(log, "w");
      const startedAt = new Date().toISOString();
      const exitCode = await new Promise((resolve, reject) => {
        const child = spawn(
          electron,
          [
            "--no-sandbox",
            "--enable-logging",
            ".",
            "-f",
            "--dev",
            "--test",
            "benchmark/fuzzy-fleet-spec.js",
          ],
          { cwd: core, env, windowsHide: true, stdio: ["ignore", descriptor, descriptor] },
        );
        child.on("error", reject);
        child.on("exit", resolve);
      });
      fs.closeSync(descriptor);
      if (
        exitCode !== 0 ||
        !fs.existsSync(output) ||
        /Uncaught error during spec run/.test(fs.readFileSync(log, "utf8"))
      )
        throw new Error(`Failed ${id}: ${log}`);
      const result = read(output);
      result.startedAt = startedAt;
      result.finishedAt = new Date().toISOString();
      result.environmentCheck = environmentCheck;
      const overlapping = smoke ? [] : otherTests();
      result.externalTestsAtFinish = overlapping.length;
      fs.appendFileSync(
        path.join(directory, "concurrency-private.jsonl"),
        JSON.stringify({ id, finishedAt: result.finishedAt, jobs: overlapping }) + "\n",
      );
      if (overlapping.length)
        throw new Error(
          `External tests overlapped ${id}; keep its private result and repeat the balanced workload`,
        );
      result.machine = {
        platform: process.platform,
        arch: process.arch,
        cpu: os.cpus()[0].model,
        logicalProcessors: os.cpus().length,
        memoryBytes: os.totalmem(),
      };
      runs.push(result);
      write(path.join(directory, smoke ? "smoke.json" : "runs.json"), runs);
      console.log(
        JSON.stringify({
          completed: id,
          cases: runs.at(-1).cases.map((value) => ({ package: value.package, count: value.count })),
        }),
      );
    }
  }
}

async function libraryRuns() {
  const runs = [];
  for (const [index, variant] of ["before", "after", "after", "before"].entries()) {
    const id = `library-${index}-${variant}`;
    const output = path.join(directory, `${id}.json`);
    const environmentCheck = await quiet(id);
    const startedAt = new Date().toISOString();
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--expose-gc", path.join(__dirname, "fuzzy-review-library.js"), variant, output],
        { windowsHide: true, stdio: "inherit" },
      );
      child.on("error", reject);
      child.on("exit", resolve);
    });
    if (exitCode !== 0) throw new Error(`Failed ${id}`);
    const overlapping = otherTests();
    fs.appendFileSync(
      path.join(directory, "concurrency-private.jsonl"),
      JSON.stringify({ id, at: new Date().toISOString(), jobs: overlapping }) + "\n",
    );
    if (overlapping.length) throw new Error(`External tests overlapped ${id}`);
    const result = read(output);
    Object.assign(result, { startedAt, finishedAt: new Date().toISOString(), environmentCheck });
    runs.push(result);
    write(path.join(directory, "library-runs.json"), runs);
    console.log(JSON.stringify({ completed: id }));
  }
}

const command = process.argv[2];
if (command === "prepare") prepare();
else if (command === "freeze-before")
  freeze("before", {
    lumine: "f4bd740393",
    "fuzzy-search": "0ac7a0f8021ff20e751cba2b06af24583d9af76c",
    "fuzzy-files": "174110f",
    "fuzzy-explorer": "f21d4fe",
  });
else if (command === "freeze-after")
  freeze("after", {
    lumine: "HEAD",
    "fuzzy-search": "HEAD",
    "fuzzy-files": "HEAD",
    "fuzzy-explorer": "HEAD",
  });
else if (command === "run" || command === "smoke")
  run(command === "smoke").catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
else if (command === "library")
  libraryRuns().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
else
  throw new Error(
    "Usage: node benchmark/fuzzy-review-run.js prepare|freeze-before|freeze-after|smoke|run",
  );
