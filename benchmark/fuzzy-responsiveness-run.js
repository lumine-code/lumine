"use strict";

const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const root = path.resolve(__dirname, "../..");
const core = path.join(root, "lumine");
const previous = path.join(root, ".dev/fuzzy-performance-review-20261023");
const directory = path.join(root, ".dev/fuzzy-responsiveness-20261023");

async function run() {
  const [
    variant,
    size = "100000",
    label = `${variant}-${size}`,
    mode = "trace",
    picker = "fuzzy-files",
  ] = process.argv.slice(2);
  if (!["before", "after"].includes(variant)) throw new Error("Expected before or after");
  const coldQueries = mode === "cold-query" || mode === "plain-cold-query";
  const tracing = mode !== "plain" && mode !== "plain-cold-query";
  fs.mkdirSync(directory, { recursive: true });
  const corpus = JSON.parse(fs.readFileSync(path.join(previous, "corpus.json")));
  const workload = corpus.workloads.find((value) => value.count === Number(size));
  if (!workload) throw new Error("Unknown frozen corpus size");
  const stem = path.join(directory, label);
  for (const suffix of ["-ready", "-done"]) {
    if (fs.existsSync(stem + suffix)) throw new Error(`Use a new label: ${label}`);
  }
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const config = {
    label,
    variant,
    count: workload.count,
    tracing,
    coldQueries,
    inputProbeIntervalMs: 8,
    corpus: workload.corpus,
    snapshot: path.join(previous, variant),
    project: corpus.project,
    activeFile: corpus.activeFile,
    ready: stem + "-ready",
    done: stem + "-done",
    output: stem + ".json",
    calibrationSamples: coldQueries ? 0 : mode === "calibration" ? 10 : 3,
    openSamples: coldQueries ? 0 : mode === "smoke" ? 2 : 20,
    querySamples: coldQueries ? 3 : mode === "smoke" ? 1 : 2,
    ...(coldQueries ? { modes: [] } : {}),
    packages: mode === "calibration" ? [] : [picker],
  };
  const env = {
    ...process.env,
    LUMINE_HOME: stem + "-home",
    LUMINE_RESOURCE_PATH: core,
    LUMINE_TEST_PACKAGES: "fuzzy-explorer fuzzy-files",
    LUMINE_FUZZY_RESPONSIVENESS: JSON.stringify(config),
  };
  delete env.CI;
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(env.LUMINE_HOME, { recursive: true });
  const log = fs.openSync(stem + ".log", "w");
  const child = spawn(
    require("electron"),
    [
      "--no-sandbox",
      "--enable-logging",
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      ".",
      "-f",
      "--dev",
      "--test",
      "benchmark/fuzzy-responsiveness-spec.js",
    ],
    { cwd: core, env, stdio: ["ignore", log, log], windowsHide: true },
  );
  let exited = false;
  let exitCode;
  const exit = new Promise((resolve) =>
    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
      resolve(code);
    }),
  );
  const waitFile = async (file) => {
    const started = Date.now();
    while (!fs.existsSync(file)) {
      if (exited) throw new Error(`Benchmark exited ${exitCode}: ${stem}.log`);
      if (Date.now() - started > 330000) throw new Error("Benchmark deadline exceeded");
      await delay(100);
    }
  };
  let client;
  let probe;
  const probes = [];
  let traceStarted = false;
  try {
    await waitFile(config.ready);
    client = await require("./fuzzy-trace-client").connect(port);
    if (tracing) {
      await client.start();
      traceStarted = true;
    }
    const sendProbe = () => {
      const timestamp = Date.now() / 1000;
      const sent = performance.now();
      const operation = client
        .send("Input.dispatchKeyEvent", {
          type: "keyDown",
          code: "F24",
          key: "F24",
          windowsVirtualKeyCode: 135,
          nativeVirtualKeyCode: 135,
          timestamp,
        })
        .then(() => ({ timestamp, sent, returned: performance.now() }));
      // Each protocol request remains observed even if the page closes on failure.
      operation.catch(() => {});
      probes.push(operation);
    };
    probe = setInterval(sendProbe, config.inputProbeIntervalMs);
    await client.evaluate("globalThis.__fuzzyGo = true");
    await waitFile(config.done);
    clearInterval(probe);
    const delivered = await Promise.all(probes);
    if (traceStarted) {
      const trace = await client.stop();
      traceStarted = false;
      fs.writeFileSync(stem + "-trace.json", JSON.stringify(trace));
    }
    fs.writeFileSync(stem + "-input.json", JSON.stringify(delivered));
    await client.evaluate("globalThis.__fuzzyRelease = true");
    const code = await exit;
    if (code !== 0) throw new Error(`Benchmark failed ${code}: ${stem}.log`);
    console.log(JSON.stringify({ label, output: config.output, trace: tracing, exitCode: code }));
  } finally {
    clearInterval(probe);
    if (traceStarted) await client.stop().catch(() => {});
    client?.close();
    // Kill only the test process we created if its protocol failed.
    if (!exited) child.kill();
    fs.closeSync(log);
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
