const Clipboard = require("../src/clipboard");
const clipboardBridge = require("../src/clipboard-bridge");

function createClipboardData(initialData = {}) {
  const data = new Map(Object.entries(initialData));
  return {
    getData(type) {
      return data.get(type) || "";
    },
    setData(type, value) {
      data.set(type, value);
    },
    get types() {
      return Array.from(data.keys());
    },
  };
}

describe("Clipboard", () => {
  describe("write(text, metadata) and read()", () => {
    it("writes and reads text to/from the native clipboard", () => {
      expect(lumine.clipboard.read()).toBe("initial clipboard content");
      lumine.clipboard.write("next");
      expect(lumine.clipboard.read()).toBe("next");
    });

    it("returns metadata if the item on the native clipboard matches the last written item", () => {
      lumine.clipboard.write("next", { meta: "data" });
      expect(lumine.clipboard.read()).toBe("next");
      expect(lumine.clipboard.readWithMetadata().text).toBe("next");
      expect(lumine.clipboard.readWithMetadata().metadata).toEqual({
        meta: "data",
      });
    });
  });

  describe("line endings", () => {
    let originalPlatform = process.platform;

    const eols = new Map([
      ["win32", "\r\n"],
      ["darwin", "\n"],
      ["linux", "\n"],
    ]);
    for (let [platform, eol] of eols) {
      it(`converts line endings to the OS's native line endings on ${platform}`, () => {
        Object.defineProperty(process, "platform", { value: platform });

        lumine.clipboard.write("next\ndone\r\n\n", { meta: "data" });
        expect(lumine.clipboard.readWithMetadata()).toEqual({
          text: `next${eol}done${eol}${eol}`,
          metadata: { meta: "data" },
        });

        Object.defineProperty(process, "platform", { value: originalPlatform });
      });
    }
  });

  describe("ClipboardEvent data", () => {
    it("writes plain text, current VS Code metadata, and Lumine editor metadata", () => {
      const clipboardData = createClipboardData();
      const metadata = { indentBasis: 0, fullLine: true };

      lumine.clipboard.createDataTransferClipboard(clipboardData).write("next\n", metadata);

      expect(clipboardData.types).toEqual([
        "text/plain",
        "application/vnd.code.copymetadata",
        "application/lumine-text-editor",
      ]);
      expect(clipboardData.getData("text/plain").replace(/\r\n/g, "\n")).toBe("next\n");

      expect(JSON.parse(clipboardData.getData("application/vnd.code.copymetadata"))).toEqual({
        defaultPastePayload: {
          multicursorText: null,
          pasteOnNewLine: true,
          mode: null,
        },
      });

      const lumineData = JSON.parse(clipboardData.getData("application/lumine-text-editor"));
      expect(lumineData.version).toBe(1);
      expect(lumineData.signature).toEqual(jasmine.any(String));
      expect(lumineData.metadata).toEqual(metadata);
    });

    it("reads Lumine metadata in a different clipboard instance", () => {
      const clipboardData = createClipboardData();
      const metadata = {
        selections: [
          { text: "one", indentBasis: 0, fullLine: false },
          { text: "two", indentBasis: 1, fullLine: true },
        ],
      };
      lumine.clipboard.createDataTransferClipboard(clipboardData).write("one\ntwo", metadata);

      const otherRendererClipboard = new Clipboard();
      expect(
        otherRendererClipboard.createDataTransferClipboard(clipboardData).readWithMetadata(),
      ).toEqual({
        text: clipboardData.getData("text/plain"),
        metadata,
      });
    });

    it("reads current VS Code copy metadata", () => {
      const clipboardData = createClipboardData({
        "text/plain": "one\ntwo",
        "application/vnd.code.copymetadata": JSON.stringify({
          defaultPastePayload: {
            pasteOnNewLine: true,
            multicursorText: ["one", "two"],
            mode: null,
          },
        }),
      });

      expect(new Clipboard().createDataTransferClipboard(clipboardData).readWithMetadata()).toEqual(
        {
          text: "one\ntwo",
          metadata: {
            fullLine: true,
            selections: [
              { text: "one", fullLine: true },
              { text: "two", fullLine: true },
            ],
          },
        },
      );
    });

    it("falls back to this window's metadata when the custom formats are stripped", () => {
      const clipboardData = createClipboardData();
      lumine.clipboard
        .createDataTransferClipboard(clipboardData)
        .write("stripped formats", { fullLine: true });

      const textOnly = createClipboardData({
        "text/plain": clipboardData.getData("text/plain"),
      });
      expect(lumine.clipboard.createDataTransferClipboard(textOnly).readWithMetadata()).toEqual({
        text: "stripped formats",
        metadata: { fullLine: true },
      });
    });

    it("does not reuse this window's metadata once the plain text differs", () => {
      const clipboardData = createClipboardData();
      lumine.clipboard
        .createDataTransferClipboard(clipboardData)
        .write("stripped formats", { fullLine: true });

      const textOnly = createClipboardData({ "text/plain": "something else" });
      expect(lumine.clipboard.createDataTransferClipboard(textOnly).readWithMetadata()).toEqual({
        text: "something else",
      });
    });

    it("ignores stale Lumine metadata when the plain text has changed", () => {
      const clipboardData = createClipboardData();
      lumine.clipboard
        .createDataTransferClipboard(clipboardData)
        .write("original", { fullLine: true });
      clipboardData.setData("text/plain", "replacement");

      expect(new Clipboard().createDataTransferClipboard(clipboardData).readWithMetadata()).toEqual(
        {
          text: "replacement",
        },
      );
    });
  });

  describe("images", () => {
    it("reads the image the main process holds", () => {
      const image = { isEmpty: () => false };
      spyOn(clipboardBridge, "readImage").and.returnValue(image);

      expect(lumine.clipboard.readImage()).toBe(image);
    });

    it("writes a NativeImage as the PNG bytes the main process expects", () => {
      const png = Buffer.from("png image data");
      spyOn(clipboardBridge, "writeImage");

      lumine.clipboard.writeImage({ toPNG: () => png });
      expect(clipboardBridge.writeImage).toHaveBeenCalledWith(png);
    });

    it("writes PNG bytes as they are", () => {
      const png = Buffer.from("png image data");
      spyOn(clipboardBridge, "writeImage");

      lumine.clipboard.writeImage(png);
      expect(clipboardBridge.writeImage).toHaveBeenCalledWith(png);
    });
  });

  describe("the primary selection", () => {
    it("reads the selection rather than the clipboard", () => {
      lumine.clipboard.readSelectionText();
      expect(clipboardBridge.readText).toHaveBeenCalledWith("selection");
    });

    it("writes without waiting for the main process", () => {
      spyOn(clipboardBridge, "writeSelectionText");

      lumine.clipboard.writeSelectionText("selected");
      expect(clipboardBridge.writeSelectionText).toHaveBeenCalledWith("selected");
      expect(clipboardBridge.writeText).not.toHaveBeenCalled();
    });
  });

  describe("native custom-format data", () => {
    it("writes text and a web custom format through the async clipboard API", async () => {
      spyOn(navigator.clipboard, "write").and.returnValue(Promise.resolve());

      const written = await lumine.clipboard.writeNativeData(
        "one two",
        "application/lumine-probe",
        {
          version: 1,
          value: "data",
        },
      );

      expect(written).toBe(true);
      const [items] = navigator.clipboard.write.calls.mostRecent().args;
      expect(items.length).toBe(1);
      expect(Array.from(items[0].types)).toEqual(["text/plain", "web application/lumine-probe"]);
      expect(await (await items[0].getType("text/plain")).text()).toBe("one two");
      expect(
        JSON.parse(await (await items[0].getType("web application/lumine-probe")).text()),
      ).toEqual({ version: 1, value: "data" });
    });

    it("falls back to plain text when the async clipboard API is unavailable", async () => {
      spyOn(navigator.clipboard, "write").and.returnValue(
        Promise.reject(new Error("Document is not focused.")),
      );

      const written = await lumine.clipboard.writeNativeData(
        "fallback text",
        "application/lumine-probe",
        {
          version: 1,
        },
      );

      expect(written).toBe(false);
      expect(lumine.clipboard.read()).toBe("fallback text");
    });

    it("reads back the payload for the requested format", async () => {
      const payload = { version: 1, value: "data" };
      spyOn(navigator.clipboard, "read").and.returnValue(
        Promise.resolve([
          { types: ["text/plain"] },
          {
            types: ["web application/lumine-probe"],
            getType: async () => new Blob([JSON.stringify(payload)]),
          },
        ]),
      );

      expect(await lumine.clipboard.readNativeData("application/lumine-probe")).toEqual(payload);
    });

    it("returns null for missing formats, invalid payloads, and read failures", async () => {
      const read = spyOn(navigator.clipboard, "read");

      read.and.returnValue(Promise.resolve([{ types: ["text/plain"] }]));
      expect(await lumine.clipboard.readNativeData("application/lumine-probe")).toBeNull();

      read.and.returnValue(
        Promise.resolve([
          {
            types: ["web application/lumine-probe"],
            getType: async () => new Blob(["not json"]),
          },
        ]),
      );
      expect(await lumine.clipboard.readNativeData("application/lumine-probe")).toBeNull();

      read.and.returnValue(
        Promise.resolve([
          {
            types: ["web application/lumine-probe"],
            getType: async () => new Blob(["[1, 2]"]),
          },
        ]),
      );
      expect(await lumine.clipboard.readNativeData("application/lumine-probe")).toBeNull();

      read.and.returnValue(Promise.reject(new Error("Document is not focused.")));
      expect(await lumine.clipboard.readNativeData("application/lumine-probe")).toBeNull();
    });
  });
});
