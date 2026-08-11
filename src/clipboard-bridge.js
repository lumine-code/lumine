const { ipcRenderer, nativeImage } = require("electron");

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
// The requests are synchronous because {@link Clipboard} is. A paste reads the
// clipboard in the middle of an edit and `lumine.clipboard.read()` is
// documented to return a `String`, so there is no seam to make asynchronous
// without changing every caller. On Linux Electron's renderer-side `clipboard`
// was already a synchronous IPC call, so this is not new cost there.
//
// {@link #writeSelectionText} is the one exception. Linux mirrors every selection
// change into the primary selection, and blocking a drag on a round trip is
// exactly what its dedicated asynchronous channel has always avoided. Both
// travel the same pipe in order, so a selection write is still visible to the
// read that follows it.
//
// This module is the seam specs replace — see `spec/helpers/jasmine-spies.js`,
// which fakes the two text methods so a spec run never touches the real
// clipboard.

const CHANNEL = "clipboard";
const SELECTION_CHANNEL = "write-text-to-selection-clipboard";

function request(method, ...args) {
  return ipcRenderer.sendSync(CHANNEL, method, args);
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
  readText(type) {
    return request("readText", type) || "";
  },

  writeText(text, type) {
    request("writeText", text, type);
  },

  readFindText() {
    return request("readFindText") || "";
  },

  writeFindText(text) {
    request("writeFindText", text);
  },

  // Returns a `NativeImage`, empty when the clipboard holds no image. The image
  // crosses the process boundary as PNG bytes, so its scale factor does not
  // survive the trip.
  readImage() {
    const png = toBuffer(request("readImage"));
    return png.length > 0 ? nativeImage.createFromBuffer(png) : nativeImage.createEmpty();
  },

  // * `png` PNG bytes, as a `Buffer` or any typed array over them.
  writeImage(png) {
    const buffer = toBuffer(png);
    if (buffer.length > 0) request("writeImage", buffer);
  },

  readSelectionText() {
    return this.readText("selection");
  },

  writeSelectionText(text) {
    ipcRenderer.send(SELECTION_CHANNEL, text);
  },
};
