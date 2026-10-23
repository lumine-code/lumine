"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

const core = path.resolve(__dirname, "..");
const root = path.dirname(core);
const previous = path.join(root, ".dev/fuzzy-performance-review-20261023");
const directory = path.join(root, ".dev/fuzzy-responsiveness-20261023");
const read = (file) => JSON.parse(fs.readFileSync(file));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const frozen = new Set([
  "src/select-list.js",
  "src/select-list-model.js",
  "src/select-list-helpers.js",
  "src/fuzzy-matcher.js",
  "src/fuzzy-search-worker.js",
  "src/fuzzy-search-worker-client.js",
]);
const buffer = Buffer.allocUnsafe(1024 * 1024);

function fileHash(file) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  try {
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)))
      hash.update(buffer.subarray(0, count));
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function fingerprint(corpus) {
  const files = {};
  const add = (file, key) => {
    files[key] = fs.existsSync(file) ? fileHash(file) : null;
  };
  const tree = (folder, prefix, excluded = new Set()) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      const key = `${prefix}/${entry.name}`;
      if (excluded.has(key.replace(/^core\//, ""))) continue;
      if (entry.isDirectory()) tree(file, key, excluded);
      else add(file, key);
    }
  };
  tree(path.join(core, "src"), "core/src", frozen);
  tree(path.join(core, "spec/helpers"), "core/spec/helpers");
  tree(path.join(core, "spec/runners"), "core/spec/runners");
  for (const name of [
    "fuzzy-responsiveness-batch.js",
    "fuzzy-responsiveness-run.js",
    "fuzzy-responsiveness-spec.js",
    "fuzzy-responsiveness-monitor.js",
    "fuzzy-review-snapshot.js",
    "fuzzy-trace-client.js",
  ])
    add(path.join(__dirname, name), `core/benchmark/${name}`);
  for (const name of ["package.json", "package-lock.json"])
    add(path.join(core, name), `core/${name}`);
  tree(path.join(core, "node_modules/@lumine-code/etch"), "etch");
  for (const variant of ["before", "after"])
    tree(path.join(previous, variant), `snapshot/${variant}`);
  add(path.join(previous, "corpus.json"), "corpus/corpus.json");
  add(corpus.activeFile, "corpus/active-document");
  for (const workload of corpus.workloads)
    add(workload.corpus, `corpus/${path.basename(workload.corpus)}`);
  for (const picker of ["fuzzy-explorer", "fuzzy-files"]) {
    for (const name of ["package.json", "package-lock.json"])
      add(path.join(root, picker, name), `packages/${picker}/${name}`);
    for (const name of ["styles", "keymaps", "menus"])
      if (fs.existsSync(path.join(root, picker, name)))
        tree(path.join(root, picker, name), `packages/${picker}/${name}`);
  }
  const ordered = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  return { hash: sha256(JSON.stringify(ordered)), files: ordered };
}

function changes(before, after) {
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].filter(
    (key) => before.files[key] !== after.files[key],
  );
}

function otherJobs(owned) {
  if (process.platform !== "win32") throw new Error("This process gate currently requires Windows");
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe','electron.exe') } | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{Name='CreatedAt';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress";
  const raw = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  ).trim();
  const values = raw ? JSON.parse(raw) : [];
  return (Array.isArray(values) ? values : [values]).filter((entry) => {
    if (owned.has(entry.ProcessId)) return false;
    const command = entry.CommandLine || "";
    return /(?:^|\s)--test(?:\s|=|$)|(?:^|[\\/\s"'])benchmark[\\/]/i.test(command);
  });
}

function cpuTicks() {
  return os.cpus().reduce(
    (sum, cpu) => {
      sum.idle += cpu.times.idle;
      sum.total += Object.values(cpu.times).reduce((a, b) => a + b, 0);
      return sum;
    },
    { idle: 0, total: 0 },
  );
}

async function quiet(slotId, owned, log) {
  const began = Date.now();
  let lastNotice = 0;
  let previousReason;
  for (;;) {
    let jobs = otherJobs(owned);
    let idleFraction = null;
    if (!jobs.length) {
      const before = cpuTicks();
      await delay(1000);
      const after = cpuTicks();
      idleFraction = (after.idle - before.idle) / (after.total - before.total);
      if (!Number.isFinite(idleFraction)) throw new Error("CPU idle sample was unavailable");
      jobs = otherJobs(owned);
    }
    const at = new Date().toISOString();
    log({ phase: "preflight", slotId, at, idleFraction, jobs });
    // 90% is a launch preference, not proof that no competing activity exists.
    if (!jobs.length && idleFraction > 0.9)
      return { at, idleFraction, waitedMs: Date.now() - began };
    const reason = jobs.length ? "other-tests-or-benchmarks" : "aggregate-cpu-busy";
    if (reason !== previousReason || Date.now() - lastNotice >= 60000) {
      console.log(JSON.stringify({ waiting: slotId, reason, jobCount: jobs.length, idleFraction }));
      lastNotice = Date.now();
      previousReason = reason;
    }
    await delay(5000);
  }
}

function options() {
  const result = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const [name, inline] = args[i].split("=", 2);
    if (!["--sizes", "--pickers", "--series", "--mode"].includes(name))
      throw new Error(
        "Usage: node benchmark/fuzzy-responsiveness-batch.js [--sizes 100000,500000] [--pickers fuzzy-explorer,fuzzy-files] [--series name] [--mode trace|plain]",
      );
    result[name.slice(2)] = inline ?? args[++i];
    if (!result[name.slice(2)]) throw new Error(`Missing value for ${name}`);
  }
  return result;
}

async function main() {
  const config = options();
  const sizes = (config.sizes || "100000,500000").split(",").map(Number);
  const pickers = (config.pickers || "fuzzy-explorer,fuzzy-files").split(",");
  const mode = config.mode || "trace";
  if (!["trace", "plain"].includes(mode)) throw new Error("Expected --mode trace or plain");
  const series = config.series || `response-${new Date().toISOString().replace(/[^0-9TZ]/g, "")}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(series)) throw new Error("Invalid series name");
  const corpus = read(path.join(previous, "corpus.json"));
  if (sizes.some((size) => !corpus.workloads.some((entry) => entry.count === size)))
    throw new Error("Unknown frozen corpus size");
  if (pickers.some((picker) => !["fuzzy-explorer", "fuzzy-files"].includes(picker)))
    throw new Error("Unknown picker");
  fs.mkdirSync(directory, { recursive: true });
  const manifestFile = path.join(directory, `${series}-batch.json`);
  const privateLog = path.join(directory, `${series}-processes-private.jsonl`);
  const log = (value) => fs.appendFileSync(privateLog, JSON.stringify(value) + "\n");
  const plan = [...new Set(sizes)].flatMap((size) =>
    [...new Set(pickers)].flatMap((picker) =>
      ["before", "after", "after", "before"].map((variant, slot) => ({
        slotId: `${size}/${picker}/${slot}`,
        size,
        picker,
        slot,
        variant,
      })),
    ),
  );
  const baseline = fingerprint(corpus);
  const batch = fs.existsSync(manifestFile)
    ? read(manifestFile)
    : {
        schemaVersion: 1,
        series,
        mode,
        createdAt: new Date().toISOString(),
        plan: [],
        fingerprint: baseline,
        runs: [],
        attempts: [],
        machine: {
          platform: process.platform,
          cpu: os.cpus()[0].model,
          logicalProcessors: os.cpus().length,
          memoryBytes: os.totalmem(),
        },
      };
  if ((batch.mode ?? "trace") !== mode)
    throw new Error("Use a different series for a different trace mode");
  const save = () => write(manifestFile, batch);
  const assertIdentity = (current) => {
    if (current.hash === batch.fingerprint.hash) return;
    batch.status = "source-changed";
    batch.changedFiles = changes(batch.fingerprint, current);
    batch.finishedAt = new Date().toISOString();
    save();
    throw new Error(`Source/corpus identity changed: ${batch.changedFiles.slice(0, 6).join(", ")}`);
  };
  assertIdentity(baseline);
  batch.mode = mode;
  for (const slot of plan)
    if (!batch.plan.some((entry) => entry.slotId === slot.slotId)) batch.plan.push(slot);
  batch.status = "running";
  save();
  const owned = new Set([process.pid]);
  for (const slot of plan) {
    if (batch.runs.some((entry) => entry.slotId === slot.slotId)) continue;
    for (;;) {
      const preflight = await quiet(slot.slotId, owned, log);
      const before = fingerprint(corpus);
      assertIdentity(before);
      const lastJobs = otherJobs(owned);
      if (lastJobs.length) {
        log({
          phase: "prelaunch-race",
          slotId: slot.slotId,
          at: new Date().toISOString(),
          jobs: lastJobs,
        });
        continue;
      }
      const attempt = 1 + batch.attempts.filter((entry) => entry.slotId === slot.slotId).length;
      const label = `${series}-${slot.size}-${slot.picker}-${slot.slot}-${slot.variant}-attempt-${attempt}`;
      const stem = path.join(directory, label);
      const record = {
        ...slot,
        label,
        mode,
        attempt,
        preflight,
        status: "running",
        startedAt: new Date().toISOString(),
        output: stem + ".json",
        trace: mode === "trace" ? stem + "-trace.json" : null,
        input: stem + "-input.json",
        log: stem + ".log",
        launcherLog: stem + "-launcher.log",
        fingerprintHash: before.hash,
      };
      batch.attempts.push(record);
      save();
      const descriptor = fs.openSync(record.launcherLog, "w");
      const env = { ...process.env };
      delete env.CI;
      delete env.ELECTRON_RUN_AS_NODE;
      try {
        record.exitCode = await new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              path.join(__dirname, "fuzzy-responsiveness-run.js"),
              slot.variant,
              String(slot.size),
              label,
              mode,
              slot.picker,
            ],
            {
              cwd: core,
              env,
              windowsHide: true,
              stdio: ["ignore", descriptor, descriptor],
            },
          );
          owned.add(child.pid);
          child.once("error", (error) => {
            owned.delete(child.pid);
            reject(error);
          });
          child.once("exit", (code) => {
            owned.delete(child.pid);
            resolve(code);
          });
        });
      } finally {
        fs.closeSync(descriptor);
      }
      record.finishedAt = new Date().toISOString();
      const resultMtime = fs.existsSync(record.output) ? fs.statSync(record.output).mtimeMs : null;
      record.resultWrittenAt = resultMtime === null ? null : new Date(resultMtime).toISOString();
      const jobs = otherJobs(owned);
      const overlap = jobs.filter(
        (job) =>
          resultMtime === null ||
          !Number.isFinite(Date.parse(job.CreatedAt)) ||
          Date.parse(job.CreatedAt) <= resultMtime,
      );
      record.externalTestsAtFinish = overlap.length;
      record.testsStartingAfterOutput = jobs.length - overlap.length;
      log({
        phase: "finished",
        label,
        at: record.finishedAt,
        resultWrittenAt: record.resultWrittenAt,
        jobs,
      });
      const after = fingerprint(corpus);
      record.fingerprintAfterHash = after.hash;
      save();
      assertIdentity(after);
      if (record.exitCode !== 0) {
        record.status = "failed";
        batch.status = "failed";
        save();
        throw new Error(`Benchmark failed (${record.exitCode}): ${record.launcherLog}`);
      }
      if (overlap.length) {
        record.status = "excluded-overlap";
        save();
        console.log(JSON.stringify({ excluded: label, retrySlot: slot.slotId }));
        continue;
      }
      const result = read(record.output);
      const workload = corpus.workloads.find((entry) => entry.count === slot.size);
      assert.equal(result.corpusHash, before.files[`corpus/${path.basename(workload.corpus)}`]);
      assert.equal(result.driverHash, before.files["core/benchmark/fuzzy-responsiveness-spec.js"]);
      assert.deepEqual(result.snapshot, read(path.join(previous, slot.variant, "manifest.json")));
      for (const [file, hash] of Object.entries(result.sources))
        assert.equal(hash, result.snapshot.hashes[file], `Loaded source differs: ${file}`);
      if (record.trace) assert.ok(fs.statSync(record.trace).size > 2, "Trace output is missing");
      assert.ok(fs.statSync(record.input).size > 2, "Input probe output is missing");
      record.artifactHashes = {
        output: fileHash(record.output),
        input: fileHash(record.input),
        trace: record.trace ? fileHash(record.trace) : null,
      };
      record.status = "accepted";
      batch.runs.push(record);
      save();
      console.log(
        JSON.stringify({ accepted: label, total: batch.runs.length, fingerprint: before.hash }),
      );
      break;
    }
  }
  batch.status = "complete";
  batch.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ complete: manifestFile, accepted: batch.runs.length }));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
