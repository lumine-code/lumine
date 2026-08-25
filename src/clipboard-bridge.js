const { nativeImage } = require("electron");
const ipcHelpers = require("./ipc-helpers");

// The renderer half of the native clipboard.
//
// Electron 43 deprecates every `clipboard` access from a renderer process: the
// module reaches the platform clipboard from whichever process asks, which is
// what site isolation is about to take away. The replacement Electron names is
// `contextBridge`, and that recipe assumes a preload script in an isolated
// world — Lumine's renderer runs with node integration and no isolated world,
// so what survives of the recipe is its substance: the main process owns the
// clipboard, and the renderer asks it over IPC.
//
// Electron 44 also made the main-process clipboard asynchronous, so every
// request uses the existing request/response IPC helper and returns a Promise.
// Native copy and paste events remain synchronous through Clipboard's
// DataTransfer-backed adapter; programmatic clipboard access follows Electron's
// Promise-based contract.
//
// This module is the seam specs replace — see `spec/helpers/jasmine-spies.js`,
// which fakes the two text methods so a spec run never touches the real
// clipboard.

const CHANNEL = "clipboard";

async function request(method, ...args) {
  const response = await ipcHelpers.call(CHANNEL, method, args);
  if (!response?.ok) throw new Error(response?.error || `Clipboard request '${method}' failed`);
  return response.value;
}

// Electron's structured clone hands a `Buffer` back as a `Uint8Array`, and
// `nativeImage.createFromBuffer` accepts only the former.
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.alloc(0);
}

module.exports = {
  async readText(type) {
    return (await request("readText", type)) || "";
  },

  writeText(text, type) {
    return request("writeText", text, type);
  },

  async readFindText() {
    return (await request("readFindText")) || "";
  },

  writeFindText(text) {
    return request("writeFindText", text);
  },

  // Returns a `NativeImage`, empty when the clipboard holds no image. The image
  // crosses the process boundary as PNG bytes, so its scale factor does not
  // survive the trip.
  async readImage() {
    const png = toBuffer(await request("readImage"));
    return png.length > 0 ? nativeImage.createFromBuffer(png) : nativeImage.createEmpty();
  },

  // * `png` PNG bytes, as a `Buffer` or any typed array over them.
  writeImage(png) {
    const buffer = toBuffer(png);
    return buffer.length > 0 ? request("writeImage", buffer) : Promise.resolve();
  },

  readSelectionText() {
    return this.readText("selection");
  },

  writeSelectionText(text) {
    return this.writeText(text, "selection");
  },
};
