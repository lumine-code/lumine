/* globals assert */

const crypto = require("node:crypto");
const fs = require("node:fs");
const originalFs = require("original-fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { BrowserWindow, session } = require("electron");
const LumineProtocolHandler = require("../../src/lumine-protocol-handler");

describe("Window package resources", () => {
  let directory, windows, handlers;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-resource-spec-"));
    windows = [];
    handlers = [];
  });

  afterEach(() => {
    for (const window of windows) window.destroy();
    for (const handler of handlers) handler.dispose();
    assert.strictEqual(fs.realpathSync(path.dirname(directory)), fs.realpathSync(os.tmpdir()));
    assert.isTrue(path.basename(directory).startsWith("lumine-resource-spec-"));
    originalFs.rmSync(directory, { recursive: true });
  });

  function packageRoot(dirname, contents) {
    const root = path.join(directory, dirname);
    fs.mkdirSync(root, { recursive: true });
    for (const [name, value] of Object.entries(contents))
      fs.writeFileSync(path.join(root, name), value);
    return root;
  }

  function createHandler(options = {}) {
    const ses = session.fromPartition(`lumine-resources-${crypto.randomUUID()}`, { cache: false });
    const handler = new LumineProtocolHandler({
      session: ses,
      assetsPath: path.join(directory, "assets"),
      resourcePath: directory,
      ...options,
    });
    handlers.push(handler);
    return handler;
  }

  function publish(handler, name, root, owner = crypto.randomUUID()) {
    handler.updatePackage({ generation: handler.generation, action: "add", name, root, owner });
    return owner;
  }

  async function renderer(handler) {
    const window = new BrowserWindow({
      show: false,
      webPreferences: { session: handler.session, offscreen: true },
    });
    windows.push(window);
    await window.loadFile(path.join(__dirname, "../fixtures/package-resource-probe.html"));
    return (url, options = {}) =>
      window.webContents.executeJavaScript(
        `fetch(${JSON.stringify(url)}, ${JSON.stringify(options)}).then(async response => ({ status: response.status, text: await response.text(), type: response.headers.get('content-type') })).catch(() => null)`,
      );
  }

  it("serves the exact loaded generation after a live replacement in the same renderer", async () => {
    const bundled = packageRoot("node_modules/resource-package", {
      "value.txt": "bundled",
      "bundled-only.txt": "private to shadowed copy",
    });
    const installed = packageRoot("packages/different-install-name", { "value.txt": "installed" });
    const development = packageRoot("packages-dev/unrelated-link-name", {
      "value.txt": "development",
    });
    const handler = createHandler();
    const read = await renderer(handler);
    publish(handler, "resource-package", bundled);
    assert.strictEqual((await read("lumine://resource-package/value.txt")).text, "bundled");
    const installedOwner = publish(handler, "resource-package", installed);
    assert.strictEqual((await read("lumine://resource-package/value.txt")).text, "installed");
    publish(handler, "resource-package", development);
    assert.strictEqual((await read("lumine://resource-package/value.txt")).text, "development");
    assert.isNull(await read("lumine://resource-package/bundled-only.txt"));
    assert.isNull(await read("lumine://unrelated-link-name/value.txt"));
    handler.updatePackage({
      generation: handler.generation,
      action: "remove",
      name: "resource-package",
      root: installed,
      owner: installedOwner,
    });
    assert.strictEqual((await read("lumine://resource-package/value.txt")).text, "development");
    const current = handler.packages.get("resource-package");
    handler.updatePackage({
      generation: handler.generation,
      action: "remove",
      name: "resource-package",
      root: development,
      owner: current.owner,
    });
    assert.isNull(await read("lumine://resource-package/value.txt"));
  });

  it("isolates safe and development windows and rejects stale renderer publications", async () => {
    const bundled = packageRoot("node_modules/resource-package", { "value.txt": "bundled" });
    const development = packageRoot("packages-dev/renamed", { "value.txt": "development" });
    const safe = createHandler({ safeMode: true });
    const dev = createHandler();
    publish(safe, "resource-package", bundled);
    publish(dev, "resource-package", development);
    const [readSafe, readDev] = await Promise.all([renderer(safe), renderer(dev)]);
    assert.strictEqual((await readSafe("lumine://resource-package/value.txt")).text, "bundled");
    assert.strictEqual((await readDev("lumine://resource-package/value.txt")).text, "development");
    assert.throws(() => publish(safe, "resource-package", development), /Safe mode/);
    const oldGeneration = dev.generation;
    dev.beginGeneration();
    assert.isFalse(
      dev.updatePackage({
        generation: oldGeneration,
        action: "add",
        name: "resource-package",
        root: development,
        owner: "old-renderer",
      }),
    );
    assert.isNull(await readDev("lumine://resource-package/value.txt"));
  });

  it("preserves scoped package identity without exposing an invented directory hostname", async () => {
    const root = packageRoot("unrelated-scoped-directory", { "value.txt": "scoped" });
    const handler = createHandler();
    const owner = publish(handler, "@scope/resource-package", root);
    assert.strictEqual(handler.packages.get("@scope/resource-package").root, root);
    const read = await renderer(handler);
    assert.isNull(await read("lumine://unrelated-scoped-directory/value.txt"));
    handler.updatePackage({
      generation: handler.generation,
      action: "remove",
      name: "@scope/resource-package",
      root,
      owner,
    });
    assert.isFalse(handler.packages.has("@scope/resource-package"));
  });

  it("denies opaque sandbox previews access to a loaded development package", async () => {
    const root = packageRoot("development", { "value.txt": "package-private-data" });
    const handler = createHandler();
    publish(handler, "resource-package", root);
    const read = await renderer(handler);
    assert.strictEqual(
      (await read("lumine://resource-package/value.txt")).text,
      "package-private-data",
    );
    const result = await windows.at(-1).webContents.executeJavaScript(`new Promise(resolve => {
      const frame = document.createElement('iframe');
      frame.sandbox = 'allow-scripts';
      const receive = event => {
        if (event.source !== frame.contentWindow) return;
        window.removeEventListener('message', receive);
        frame.remove();
        resolve(event.data);
      };
      window.addEventListener('message', receive);
      frame.srcdoc = '<script>fetch("lumine://resource-package/value.txt").then(r => r.text()).then(value => parent.postMessage({value}, "*"), () => parent.postMessage({denied:true}, "*"))<\\/script>';
      document.body.append(frame);
    })`);
    assert.deepEqual(result, { denied: true });
  });

  it("serves native fixed assets, HEAD and encoded Unicode paths without exposing other hosts", async () => {
    packageRoot("assets", {
      "zażółć.txt": "asset",
      "icon.svg": '<svg xmlns="http://www.w3.org/2000/svg" />',
    });
    const handler = createHandler();
    const read = await renderer(handler);
    assert.strictEqual(
      (await read("lumine-assets://local/za%C5%BC%C3%B3%C5%82%C4%87.txt")).text,
      "asset",
    );
    const svg = await read("lumine-assets://local/icon.svg", { method: "HEAD" });
    assert.strictEqual(svg.text, "");
    assert.include(svg.type, "image/svg+xml");
    assert.isNull(await read("lumine-assets://other/icon.svg"));
    assert.isNull(await read("lumine-assets://local/"));
    assert.isNull(await read("lumine-assets://local/icon.svg", { method: "POST" }));
    assert.isNotNull(handler.session.protocol.getSource("lumine-assets"));
    assert.isNull(handler.session.protocol.getSource("lumine"));
  });

  it("rejects encoded traversal, alternate separators and symlinks outside the loaded root", async () => {
    const root = packageRoot("package", { "value.txt": "allowed" });
    const outside = packageRoot("outside", { "secret.txt": "secret" });
    fs.symlinkSync(
      outside,
      path.join(root, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const handler = createHandler();
    publish(handler, "resource-package", root);
    const read = await renderer(handler);
    for (const resource of [
      "..%2Foutside%2Fsecret.txt",
      "..%5Coutside%5Csecret.txt",
      "%00secret.txt",
      "escape/secret.txt",
      "%2Fsecret.txt",
      "missing.txt",
    ]) {
      assert.isNull(await read(`lumine://resource-package/${resource}`), resource);
    }
    assert.isNull(await read("lumine://resource-package/value.txt", { method: "POST" }));
    assert.strictEqual((await read("lumine://resource-package/value.txt")).text, "allowed");
  });

  it("serves resources from an ASAR package with native MIME types and byte ranges", async () => {
    const source = packageRoot("archive-source", {
      "value.txt": "0123456789",
      "icon.svg": '<svg xmlns="http://www.w3.org/2000/svg" />',
    });
    const archive = path.join(directory, "package.asar");
    await require("@electron/asar").createPackage(source, archive);
    // Electron holds opened archives for the process lifetime. Keep that cache
    // in a child so Windows can remove the fixture when this test completes.
    const env = { ...process.env };
    delete env.CI;
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--no-sandbox",
          path.join(__dirname, "../fixtures/package-resource-asar-probe.cjs"),
          archive,
        ],
        { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (data) => (output += data));
      child.stderr.on("data", (data) => (output += data));
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("ASAR resource probe timed out"));
      }, 15000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    });
    assert.strictEqual(result.code, 0, result.output);
    assert.include(result.output, "ASAR_RESOURCE_PROBE_PASSED");
  });
});
