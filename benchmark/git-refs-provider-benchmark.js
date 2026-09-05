const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const GitRepositoryRefsProvider = require("../src/git-repository-refs-provider");

// Run with `node benchmark/git-refs-provider-benchmark.js`. Set SIZE,
// SCENARIO (local, remote, or tag), STORAGE (packed or loose), and
// INCLUDE_LEGACY through the LUMINE_GIT_REFS_BENCHMARK_* environment variables.
const count = Number(process.env.LUMINE_GIT_REFS_BENCHMARK_SIZE || 10000);
const scenarioFilter = process.env.LUMINE_GIT_REFS_BENCHMARK_SCENARIO || "";
const includeLegacy = process.env.LUMINE_GIT_REFS_BENCHMARK_INCLUDE_LEGACY === "1";
const storage = process.env.LUMINE_GIT_REFS_BENCHMARK_STORAGE || "packed";

if (storage !== "packed" && storage !== "loose") {
  throw new Error(`Unsupported ref storage: ${storage}`);
}
if (storage === "loose" && !scenarioFilter) {
  throw new Error("Loose-ref benchmarks require LUMINE_GIT_REFS_BENCHMARK_SCENARIO");
}

const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-git-refs-"));

function git(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function measure(name, args) {
  process.stderr.write(`Measuring ${name}...\n`);
  const start = performance.now();
  const output = git(args);
  const result = {
    name,
    durationMs: performance.now() - start,
    outputBytes: Buffer.byteLength(output),
  };
  process.stderr.write(`${name}: ${result.durationMs.toFixed(1)} ms\n`);
  return result;
}

async function measureProvider(provider, name = "provider-snapshot") {
  process.stderr.write(`Measuring ${name}...\n`);
  const start = performance.now();
  const output = await provider.getRefs(repositoryPath);
  const result = {
    name,
    durationMs: performance.now() - start,
    outputBytes: Buffer.byteLength(JSON.stringify(output)),
  };
  process.stderr.write(`${name}: ${result.durationMs.toFixed(1)} ms\n`);
  return result;
}

async function main() {
  try {
    git(["init", "--initial-branch=main"]);
    git(["config", "user.name", "Lumine Benchmark"]);
    git(["config", "user.email", "benchmark@lumine.invalid"]);
    fs.writeFileSync(path.join(repositoryPath, "file.txt"), "content\n");
    git(["add", "file.txt"]);
    git(["commit", "-m", "Initial commit"]);
    const oid = git(["rev-parse", "HEAD"]).trim();
    const prefix = ["for-each-ref"];
    const refs = ["refs/heads", "refs/remotes", "refs/tags"];
    // Mirrors the all-ref scan used by GitRepositoryRefsProvider. Upstream and
    // push routing are intentionally measured by targeted provider tests: they
    // run only when configuration says they can produce data.
    const snapshotBaseAtoms = [
      "%(refname)",
      "",
      "%(objectname)",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "%(HEAD)",
      "%(symref)",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ];
    const variants = [
      ["refname-baseline", ["%(refname)"]],
      ["canonical-name", ["%(refname:lstrip=2)"]],
      ["snapshot-base-format", snapshotBaseAtoms],
    ];
    if (includeLegacy) {
      variants.splice(2, 0, ["legacy-short-name", ["%(refname:short)"]]);
    }
    const scenarios = [
      ["local", "refs/heads/branch-"],
      ["remote", "refs/remotes/origin/branch-"],
      ["tag", "refs/tags/tag-"],
    ];
    const scenarioResults = [];
    const provider = new GitRepositoryRefsProvider();
    for (const [scenario, refPrefix] of scenarios) {
      if (scenarioFilter && scenario !== scenarioFilter) continue;
      const refLines = [];
      for (let index = 0; index < count; index++) {
        const ref = `${refPrefix}${index}`;
        refLines.push(`${oid} ${ref}`);
        if (storage === "loose") {
          const refPath = path.join(repositoryPath, ".git", ...ref.split("/"));
          fs.mkdirSync(path.dirname(refPath), { recursive: true });
          fs.writeFileSync(refPath, `${oid}\n`);
        }
      }
      if (storage === "packed") {
        const packedRefs = ["# pack-refs with: peeled fully-peeled sorted", ...refLines.sort()];
        fs.writeFileSync(
          path.join(repositoryPath, ".git", "packed-refs"),
          `${packedRefs.join("\n")}\n`,
        );
      }

      const results = [];
      for (const [name, atoms] of variants) {
        results.push(measure(name, [...prefix, `--format=${atoms.join("%00")}`, ...refs]));
      }
      results.push(await measureProvider(provider));
      if (scenario === "local") {
        git(["remote", "add", "origin", "https://example.invalid/repository.git"]);
        git(["config", "push.default", "current"]);
        results.push(await measureProvider(provider, "provider-push-current"));
        git(["config", "push.default", "nothing"]);
        results.push(await measureProvider(provider, "provider-push-disabled"));
      }

      scenarioResults.push({ scenario, refCount: count + 1, results });
    }
    console.log(JSON.stringify({ count, storage, scenarios: scenarioResults }, null, 2));
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
