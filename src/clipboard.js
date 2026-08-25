const crypto = require("crypto");
const clipboard = require("./clipboard-bridge");

const VSCODE_COPY_METADATA_FORMAT = "application/vnd.code.copymetadata";
const LUMINE_TEXT_EDITOR_DATA_FORMAT = "application/lumine-text-editor";
const LUMINE_EDITOR_DATA_VERSION = 1;

function isPromise(value) {
  return value != null && typeof value.then === "function";
}

/**
 * @public
 * @status extended
 *
 * Represents the clipboard used for copying and pasting in Lumine.
 *
 * An instance of this class is always available as the `lumine.clipboard` global.
 *
 * This class owns what the clipboard holds, not what a paste does with it. To
 * intercept a paste before the editor inserts it as text — to handle an image,
 * say — register a provider with {@link PasteProviderRegistry} through
 * `lumine.pasteProviders`.
 *
 * It is also the only supported route to the native clipboard from a package:
 * Electron exposes its Promise-based clipboard only in the main process, so
 * every programmatic read and write here crosses the process boundary (see
 * `src/clipboard-bridge.js`). Native ClipboardEvents use a synchronous
 * DataTransfer-backed adapter for the duration of the event.
 *
 * ## Examples
 *
 * ```js
 * await lumine.clipboard.write('hello')
 *
 * console.log(await lumine.clipboard.read()) // 'hello'
 * ```
 */
module.exports = class Clipboard {
  constructor() {
    this.reset();
  }

  reset() {
    this.metadata = null;
    this.signatureForMetadata = null;
  }

  // Creates an `md5` hash of some text.
  //
  // * `text` A `String` to hash.
  //
  // Returns a hashed `String`.
  md5(text) {
    return crypto.createHash("md5").update(text, "utf8").digest("hex");
  }

  normalizeText(text) {
    return text.replace(/\r\n?|\n/g, process.platform === "win32" ? "\r\n" : "\n");
  }

  signatureForText(text) {
    return this.md5(text.replace(/\r\n?|\n/g, "\n"));
  }

  /**
   * @public
   * @status public
   *
   * Write the given text to the clipboard.
   *
   * The metadata associated with the text is available by calling
   * {@link #readWithMetadata}.
   *
   * @param text - The `String` to store.
   * @param [metadata] - The additional info to associate with the text.
   * @returns {Promise} that resolves after the system clipboard has been updated.
   */
  write(text, metadata) {
    text = this.normalizeText(text);

    const didWrite = clipboard.writeText(text);
    const updateMetadata = () => {
      this.signatureForMetadata = this.md5(text);
      this.metadata = metadata;
    };
    if (isPromise(didWrite)) return didWrite.then(updateMetadata);
    updateMetadata();
    return didWrite;
  }

  // Batch editor copy/cut operations through a synchronous in-memory clipboard
  // and commit their final text plus metadata with one asynchronous native write.
  createMemoryClipboard() {
    let state = { text: "" };
    let didWrite = false;
    return {
      write: (text, metadata) => {
        state = { text, metadata };
        didWrite = true;
      },
      readWithMetadata: () => state,
      didWrite: () => didWrite,
      flush: () => (didWrite ? this.write(state.text, state.metadata) : Promise.resolve()),
    };
  }

  createDataTransferClipboard(clipboardData) {
    let state = this.readFromDataTransfer(clipboardData);
    let didWrite = false;

    return {
      write: (text, metadata) => {
        state = this.writeToDataTransfer(clipboardData, text, metadata);
        didWrite = true;
      },
      readWithMetadata: () => state,
      didWrite: () => didWrite,
    };
  }

  readFromDataTransfer(clipboardData) {
    if (typeof clipboardData.getData !== "function") return { text: "" };

    try {
      const text = clipboardData.getData("text/plain");
      const lumineData = this.readDataTransferData(clipboardData, LUMINE_TEXT_EDITOR_DATA_FORMAT);
      const lumineMetadata = this.metadataFromLumineEditorData(lumineData, text);
      // A Lumine payload that fails validation is stale, and the VS Code copy
      // metadata written alongside it carries no signature, so it is equally
      // stale. Only fall back to it when the clipboard has no Lumine payload.
      const vscodeCopyMetadata =
        lumineData == null
          ? this.metadataFromSerializedCopyMetadata(
              clipboardData.getData(VSCODE_COPY_METADATA_FORMAT),
            )
          : null;
      const metadata = lumineMetadata || vscodeCopyMetadata;
      if (metadata) return { text, metadata };
      // Chromium strips the custom formats from some paste events — natively,
      // ctrl+shift+v means "paste and match style". Fall back to the metadata
      // of this window's last write while the text still matches it, exactly
      // like {@link #readWithMetadata}.
      if (this.metadata != null && this.signatureForMetadata === this.md5(text)) {
        return { text, metadata: this.metadata };
      }
      return { text };
    } catch {
      return { text: "" };
    }
  }

  writeToDataTransfer(clipboardData, text, metadata) {
    text = this.normalizeText(text);
    const lumineData = this.buildLumineEditorData(text, metadata);
    const copyMetadata = this.buildVSCodeCopyMetadata(metadata);

    clipboardData.setData("text/plain", text);
    clipboardData.setData(VSCODE_COPY_METADATA_FORMAT, JSON.stringify(copyMetadata));
    if (lumineData) {
      this.writeDataTransferData(clipboardData, LUMINE_TEXT_EDITOR_DATA_FORMAT, lumineData);
    }

    this.signatureForMetadata = this.md5(text);
    this.metadata = metadata;
    return { text, metadata };
  }

  buildLumineEditorData(text, metadata) {
    if (metadata == null) return null;
    try {
      JSON.stringify(metadata);
      return {
        version: LUMINE_EDITOR_DATA_VERSION,
        signature: this.signatureForText(text),
        metadata,
      };
    } catch {
      return null;
    }
  }

  buildVSCodeCopyMetadata(metadata) {
    const selections = Array.isArray(metadata?.selections) ? metadata.selections : null;
    const pasteOnNewLine = selections
      ? selections.length > 0 && selections.every((selection) => selection?.fullLine === true)
      : metadata?.fullLine === true;
    const multicursorText =
      selections && selections.length > 1 ? selections.map((selection) => selection.text) : null;

    return {
      defaultPastePayload: {
        multicursorText,
        pasteOnNewLine,
        mode: null,
      },
    };
  }

  writeDataTransferData(clipboardData, format, data) {
    clipboardData.setData(format, JSON.stringify(data));
  }

  /**
   * @public
   * @status public
   *
   * Write text plus a JSON payload for a custom format to the system
   * clipboard through the async Clipboard API.
   *
   * Chromium registers `web `-prefixed custom formats with the operating
   * system, so any window can read the payload back with {@link #readNativeData}.
   * Custom formats written through a DataTransfer during a copy event are only
   * readable inside paste ClipboardEvents, and renderer-initiated
   * `execCommand("paste")` never fires one, so this is the only way to
   * round-trip a custom format without a native paste keystroke.
   *
   * @param text - The plain-text `String` to store alongside the payload.
   * @param format - The MIME-style format `String`, without the `web ` prefix.
   * @param data - The JSON-serializable payload.
   * @returns {Promise} that resolves to `true` when the payload was written, or `false` when only the plain text could be written.
   */
  async writeNativeData(text, format, data) {
    text = this.normalizeText(text);
    try {
      const type = `web ${format}`;
      const item = new ClipboardItem({
        "text/plain": new Blob([text], { type: "text/plain" }),
        [type]: new Blob([JSON.stringify(data)], { type }),
      });
      await navigator.clipboard.write([item]);
      return true;
    } catch {
      await clipboard.writeText(text);
      return false;
    }
  }

  /**
   * @public
   * @status public
   *
   * Read a JSON payload written by {@link #writeNativeData} in this or any
   * other window.
   *
   * @param format - The MIME-style format `String`, without the `web ` prefix.
   * @returns {Promise} that resolves to the parsed payload `Object`, or `null` when the clipboard holds no valid payload for the format.
   */
  async readNativeData(format) {
    try {
      const type = `web ${format}`;
      for (const item of await navigator.clipboard.read()) {
        if (item.types.includes(type)) {
          const blob = await item.getType(type);
          return this.parseDataTransferData(await blob.text());
        }
      }
    } catch {
      // Fall through to the null return below: an unfocused document or a
      // clipboard owned by another application reads as "no payload".
    }
    return null;
  }

  readDataTransferData(clipboardData, format) {
    if (typeof clipboardData?.getData !== "function") return null;
    try {
      return this.parseDataTransferData(clipboardData.getData(format));
    } catch {
      return null;
    }
  }

  parseDataTransferData(serialized) {
    if (!serialized) return null;
    let data;
    try {
      data = JSON.parse(serialized);
    } catch {
      return null;
    }
    if (data == null || typeof data !== "object" || Array.isArray(data)) {
      return null;
    }
    return data;
  }

  /**
   * @public
   * @status public
   *
   * Read the text from the clipboard.
   *
   * @returns {Promise} that resolves to the clipboard text as a `String`.
   */
  read() {
    return clipboard.readText();
  }

  /**
   * @public
   * @status public
   *
   * Write the given text to the macOS find pasteboard.
   *
   * @returns {Promise} that resolves after the find pasteboard has been updated.
   */
  writeFindText(text) {
    return clipboard.writeFindText(text);
  }

  /**
   * @public
   * @status public
   *
   * Read the text from the macOS find pasteboard.
   *
   * @returns {Promise} that resolves to the find pasteboard text as a `String`.
   */
  readFindText() {
    return clipboard.readFindText();
  }

  /**
   * @public
   * @status public
   *
   * Read the image on the clipboard.
   *
   * The image crosses the process boundary as PNG bytes, so its scale factor
   * does not survive the trip.
   *
   * @returns {Promise} that resolves to a `NativeImage`, empty when the clipboard holds no image.
   */
  readImage() {
    return clipboard.readImage();
  }

  /**
   * @public
   * @status public
   *
   * Write an image to the clipboard, replacing whatever it held.
   *
   * @param image - A `NativeImage`, or the PNG bytes of one as a `Buffer`.
   * @returns {Promise} that resolves after the image has been written.
   */
  writeImage(image) {
    return clipboard.writeImage(typeof image?.toPNG === "function" ? image.toPNG() : image);
  }

  /**
   * @public
   * @status public
   *
   * Read the text from the Linux primary selection.
   *
   * @returns {Promise} that resolves to a `String`, always empty on platforms without a primary selection.
   */
  readSelectionText() {
    return clipboard.readSelectionText();
  }

  /**
   * @public
   * @status public
   *
   * Write the given text to the Linux primary selection.
   *
   * @param text - The `String` to store.
   * @returns {Promise} that resolves after the primary selection has been updated.
   */
  writeSelectionText(text) {
    return clipboard.writeSelectionText(text);
  }

  /**
   * @public
   * @status public
   *
   * Read the text from the clipboard and return both the text and the
   * associated metadata.
   *
   * Metadata copied in another window only flows through paste
   * ClipboardEvents (see `createDataTransferClipboard`): Chromium stores
   * DataTransfer custom formats in a private bundle that Electron's clipboard
   * API cannot read back, so there is no native-format fallback here.
   *
   * * `text` The `String` clipboard text.
   * * `metadata` The metadata stored by an earlier call to {@link #write}.
   *
   * @returns {Promise} that resolves to an `Object` with the following keys:
   */
  readWithMetadata() {
    const didRead = this.read();
    const withMetadata = (text) =>
      this.signatureForMetadata === this.md5(text) ? { text, metadata: this.metadata } : { text };
    return isPromise(didRead) ? didRead.then(withMetadata) : withMetadata(didRead);
  }

  metadataFromSerializedCopyMetadata(serialized) {
    if (!serialized) return null;

    const copyMetadata = this.parseDataTransferData(serialized);
    const payload = copyMetadata?.defaultPastePayload;
    if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return null;

    return this.metadataFromVSCodeEditorData({
      isFromEmptySelection: payload.pasteOnNewLine,
      multicursorText: payload.multicursorText,
    });
  }

  metadataFromLumineEditorData(lumineData, text) {
    if (
      lumineData?.version !== LUMINE_EDITOR_DATA_VERSION ||
      lumineData.signature !== this.signatureForText(text) ||
      !this.isValidMetadata(lumineData.metadata)
    ) {
      return null;
    }
    return lumineData.metadata;
  }

  metadataFromVSCodeEditorData(editorData) {
    const metadata = {};
    let hasMetadata = false;

    if (typeof editorData.isFromEmptySelection === "boolean") {
      metadata.fullLine = editorData.isFromEmptySelection;
      hasMetadata = true;
    }

    if (
      Array.isArray(editorData.multicursorText) &&
      editorData.multicursorText.length > 0 &&
      editorData.multicursorText.every((text) => typeof text === "string")
    ) {
      metadata.selections = editorData.multicursorText.map((text) => ({
        text,
        fullLine: editorData.isFromEmptySelection === true,
      }));
      hasMetadata = true;
    }

    return hasMetadata ? metadata : null;
  }

  isValidMetadata(metadata) {
    if (metadata == null || typeof metadata !== "object" || Array.isArray(metadata)) {
      return false;
    }

    if (metadata.fullLine != null && typeof metadata.fullLine !== "boolean") return false;
    if (metadata.indentBasis != null && !Number.isFinite(metadata.indentBasis)) return false;

    if (metadata.selections != null) {
      if (!Array.isArray(metadata.selections)) return false;
      return metadata.selections.every(
        (selection) =>
          selection != null &&
          typeof selection === "object" &&
          !Array.isArray(selection) &&
          typeof selection.text === "string" &&
          (selection.fullLine == null || typeof selection.fullLine === "boolean") &&
          (selection.indentBasis == null || Number.isFinite(selection.indentBasis)),
      );
    }

    return true;
  }
};
