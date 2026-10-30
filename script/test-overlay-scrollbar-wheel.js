// Trusted wheel input in an owned normal window. Native content is the oracle
// for the same gesture over its sibling scrollbar; no screenshot is generated.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((item) => item.type === "page" && item.url.includes("index.html"));
  if (!target) throw new Error("The owned renderer was not found");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return {
    send,
    close: () => socket.close(),
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description || result.exceptionDetails.text,
        );
      return result.result.value;
    },
  };
}

async function freePort() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function main(argv) {
  const option = (name) => {
    const index = argv.indexOf(name);
    return index < 0 ? null : argv[index + 1];
  };
  const resource = path.resolve(option("--resource") || ROOT);
  const output = option("--output");
  const baseline = argv.includes("--expect-regression");
  if (output && fs.existsSync(output)) throw new Error("Use a fresh wheel report path");
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-native-wheel-"));
  const drive = path.join(resource, "script", "drive.js");
  const env = {
    ...process.env,
    LUMINE_RESOURCE_PATH: resource,
    LUMINE_DEV_MODE: "0",
    LUMINE_DISABLE_URI_HANDLER_REGISTRATION: "1",
  };
  delete env.CI;
  delete env.ELECTRON_RUN_AS_NODE;
  const command = (...args) =>
    exec(process.execPath, [drive, ...args, "--port", String(port), "--home", home], {
      cwd: resource,
      env,
      windowsHide: true,
      timeout: 120000,
    });
  const report = {
    normalWindow: true,
    platform: process.platform,
    runtimeHash: crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(resource, "src", "overlay-scrollbar.js")))
      .digest("hex"),
    cases: [],
  };
  let client;
  try {
    await command("launch", "--no-dev", "--fresh");
    client = await connect(port);
    if (await client.evaluate("lumine.inDevMode()"))
      throw new Error("Trusted input must be checked in a normal window");
    await client.evaluate(
      fs.readFileSync(
        path.join(__dirname, "..", "benchmark", "helpers", "overlay-scrollbar-wheel-probe.js"),
        "utf8",
      ),
    );
    const cases = [
      { name: "vertical thumb", hit: "thumb", y: 60 },
      { name: "vertical track", hit: "track", y: 60 },
      { name: "overlay thumb", hit: "thumb", y: 60, layout: "overlay" },
      { name: "horizontal track", hit: "track", x: 60, horizontal: true },
      { name: "Shift wheel", hit: "thumb", y: 60, horizontal: true, modifiers: 8 },
      { name: "RTL horizontal thumb", hit: "thumb", x: 60, horizontal: true, rtl: true },
      { name: "native ancestor boundary", hit: "track", y: 60, boundary: true },
      { name: "contained boundary", hit: "track", y: 60, boundary: true, contain: true },
      { name: "authored cancellation", hit: "thumb", y: 60, authored: "cancel" },
      { name: "authored propagation stop", hit: "thumb", y: 60, authored: "stop" },
      { name: "custom host handles once", hit: "track", y: 60, authored: "host" },
      { name: "editor nested output", hit: "thumb", y: 60, editor: true, chaining: false },
      {
        name: "editor nested boundary owned",
        hit: "track",
        y: 60,
        editor: true,
        chaining: false,
        boundary: true,
      },
      {
        name: "editor nested boundary chains",
        hit: "track",
        y: 60,
        editor: true,
        chaining: true,
        boundary: true,
      },
    ];
    for (const scenario of cases) {
      await client.evaluate(`overlayWheelProbe.setup(${JSON.stringify(scenario)})`);
      const measure = async (hit) => {
        let plan = await client.evaluate(`overlayWheelProbe.reset(${JSON.stringify(hit)})`);
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...plan.point,
          buttons: 0,
        });
        // Let hover-driven editor updates finish before restoring the exact
        // starting offsets for the native-content/portal comparison.
        await sleep(150);
        plan = await client.evaluate(`overlayWheelProbe.reset(${JSON.stringify(hit)})`);
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          ...plan.point,
          deltaX: scenario.x || 0,
          deltaY: scenario.y || 0,
          modifiers: scenario.modifiers || 0,
        });
        await sleep(550);
        const after = await client.evaluate("overlayWheelProbe.state()");
        return { before: plan.state, after };
      };
      const native = await measure("content");
      const rail = await measure(scenario.hit);
      const mismatches = [];
      for (const key of ["innerX", "innerY", "outerX", "outerY"])
        if (Math.abs(native.after[key] - rail.after[key]) >= 1) mismatches.push(key);
      if (native.after.ownerCalls !== rail.after.ownerCalls) mismatches.push("ownerCalls");
      if (native.after.ancestorCalls !== rail.after.ancestorCalls) mismatches.push("ancestorCalls");
      if (native.after.ownerTrusted.length !== 1 || native.after.ownerTrusted[0] !== true)
        mismatches.push("nativeInputNotTrusted");
      if (rail.after.railTrusted.length !== 1 || rail.after.railTrusted[0] !== true)
        mismatches.push("railInputNotTrusted");
      report.cases.push({ name: scenario.name, native, rail, mismatches });
    }
    const failed = report.cases.filter((item) => item.mismatches.length);
    report.status = failed.length ? "regression-observed" : "passed";
    console.log(JSON.stringify(report, null, 2));
    if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    if (baseline ? !failed.length : failed.length)
      throw new Error(
        `${failed.length} trusted scrollbar wheel comparisons differ from native content`,
      );
  } finally {
    await client?.evaluate("overlayWheelProbe?.cleanup()").catch(() => {});
    client?.close();
    await command("quit").catch(() => {});
  }
}

if (require.main === module)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
