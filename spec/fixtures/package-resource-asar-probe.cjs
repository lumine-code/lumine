const { app, protocol, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const LumineProtocolHandler = require("../../src/lumine-protocol-handler");

protocol.registerSchemesAsPrivileged(["lumine", "lumine-assets"].map(scheme => ({ scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } })));
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  const archive = process.argv[process.argv.length - 1];
  const ses = session.fromPartition("asar-resource-probe", { cache: false });
  const handler = new LumineProtocolHandler({ session: ses, assetsPath: path.dirname(archive), resourcePath: path.dirname(archive) });
  handler.updatePackage({ generation: handler.generation, action: "add", name: "resource-package", root: archive, owner: "asar-generation" });
  const window = new BrowserWindow({ show: false, webPreferences: { session: ses, offscreen: true } });
  await window.loadFile(path.join(__dirname, "package-resource-probe.html"));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const plain = await fetch('lumine://resource-package/value.txt');
    const ranged = await fetch('lumine://resource-package/value.txt', { headers: {Range:'bytes=2-5'} });
    const head = await fetch('lumine://resource-package/icon.svg', { method:'HEAD' });
    return { plain:await plain.text(), rangeStatus:ranged.status, rangeText:await ranged.text(), headText:await head.text(), type:head.headers.get('content-type') };
  })()`);
  assert.strictEqual(result.plain, "0123456789");
  assert.strictEqual(result.rangeStatus, 206);
  assert.strictEqual(result.rangeText, "2345");
  assert.strictEqual(result.headText, "");
  assert.match(result.type, /image\/svg\+xml/);
  window.destroy();
  handler.dispose();
  console.log("ASAR_RESOURCE_PROBE_PASSED");
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
