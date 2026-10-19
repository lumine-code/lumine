const { Readable } = require("stream");
const fs = require("fs");
const os = require("os");
const path = require("path");
const TextBuffer = require("../src/text-buffer");
const { conditionPromise } = require("./helpers/async-spec-helpers");

describe("TextBuffer change origins", () => {
  let buffer;
  let source;

  beforeEach(async () => {
    jasmine.useRealClock();
    source = {
      text: "abc",
      getPath: () => null,
      existsSync: () => true,
      createReadStream() {
        return Readable.from([this.text]);
      },
      onDidChange(callback) {
        this.changed = callback;
        return { dispose() {} };
      },
    };
    buffer = await TextBuffer.load(source);
  });

  afterEach(() => buffer.destroy());

  function stoppedChanging() {
    return new Promise((resolve) => {
      const subscription = buffer.onDidStopChanging((event) => {
        subscription.dispose();
        resolve(event);
      });
    });
  }

  it("identifies watched disk changes in synchronous and idle events", async () => {
    const order = [];
    const changes = [];
    const applied = [];
    buffer.onWillReload(() => order.push("will-reload"));
    buffer.onDidApplyChanges((event) => applied.push(event));
    buffer.onDidChangeText((event) => {
      order.push("change");
      changes.push(event);
    });
    buffer.onDidReload(() => order.push("did-reload"));
    const idle = stoppedChanging();
    source.text = "abcd";
    source.changed();
    await conditionPromise(() => buffer.getText() === source.text, "watched contents reloaded");
    const event = await idle;

    expect(order).toEqual(["will-reload", "change", "did-reload"]);
    expect(changes.map((change) => change.origin)).toEqual(["reload"]);
    expect(applied.map((change) => change.origin)).toEqual(["reload"]);
    expect(applied[0].changes.every((change) => change.origin === "reload")).toBe(true);
    expect(event.origin).toBe("reload");
    expect(event.transactions.map((transaction) => transaction.origin)).toEqual(["reload"]);
    expect(event.transactions[0].changes[0].newText).toBe("d");
    expect(buffer.getFileState()).toBe("unmodified");
  });

  it("preserves a reload followed by editing within one idle interval", async () => {
    const idle = stoppedChanging();
    source.text = "abcd";
    await buffer.load({ internal: true });
    buffer.append("(");
    const event = await idle;

    expect(event.origin).toBe("mixed");
    expect(event.changes[0].newText).toBe("d(");
    expect(event.transactions.map((transaction) => transaction.origin)).toEqual(["reload", "edit"]);
    expect(event.transactions.map((transaction) => transaction.changes[0].newText)).toEqual([
      "d",
      "(",
    ]);
    expect(event.transactions[1].changes[0].newRange.start.serialize()).toEqual([0, 4]);
  });

  it("identifies clearing a missing file during forced reload as reload", async () => {
    source.existsSync = () => false;
    source.createReadStream = () => {
      const error = new Error("Missing source");
      error.code = "ENOENT";
      throw error;
    };
    const origins = [];
    buffer.onDidChangeText((event) => origins.push(event.origin));
    const idle = stoppedChanging();
    await buffer.reload();
    const event = await idle;

    expect(buffer.getText()).toBe("");
    expect(buffer.getFileState()).toBe("removed");
    expect(origins).toEqual(["reload"]);
    expect(event.origin).toBe("reload");
    expect(event.transactions[0].changes[0].oldText).toBe("abc");
  });

  it("distinguishes ordinary edits and history operations from the preceding reload", async () => {
    const origins = [];
    buffer.onDidChangeText((event) => origins.push(event.origin));
    source.text = "abcd";
    await buffer.reload();
    buffer.append("e");
    buffer.undo();
    buffer.redo();

    expect(origins).toEqual(["reload", "edit", "undo", "redo"]);
  });

  it("identifies undo and redo in text, applied-change, marker and display events", () => {
    const textOrigins = [];
    const applied = [];
    const markerOrigins = [];
    const displayOrigins = [];
    const marker = buffer.markRange([
      [0, 0],
      [0, 3],
    ]);
    const display = buffer.addDisplayLayer();
    display.getScreenLineCount();
    buffer.onDidChangeText((event) => textOrigins.push(event.origin));
    buffer.onDidApplyChanges((event) => applied.push(event));
    marker.onDidChange((event) => markerOrigins.push(event.origin));
    display.onDidChange((changes) =>
      displayOrigins.push(...changes.map((change) => change.origin)),
    );

    buffer.insert([0, 1], "d");
    buffer.undo();
    buffer.redo();

    const expected = ["edit", "undo", "redo"];
    expect(buffer.getText()).toBe("adbc");
    expect(textOrigins).toEqual(expected);
    expect(applied.map((event) => event.origin)).toEqual(expected);
    expect(applied.map((event) => event.changes.map((change) => change.origin))).toEqual(
      expected.map((origin) => [origin]),
    );
    expect(markerOrigins).toEqual(expected);
    expect(displayOrigins).toEqual(expected);
  });

  it("preserves history operations and subsequent typing within one idle interval", async () => {
    const idle = stoppedChanging();
    buffer.append("d");
    buffer.undo();
    buffer.redo();
    buffer.append("e");
    const event = await idle;

    expect(event.origin).toBe("mixed");
    expect(event.transactions.map((transaction) => transaction.origin)).toEqual([
      "edit",
      "undo",
      "redo",
      "edit",
    ]);
    expect(event.transactions.map((transaction) => transaction.changes[0].newText)).toEqual([
      "d",
      "",
      "d",
      "e",
    ]);
    expect(event.changes[0].newText).toBe("de");
    expect(buffer.getText()).toBe("abcde");
  });

  it("preserves undo and redo origins for independent line edit batches", () => {
    const original = "row\n".repeat(64);
    buffer.destroy();
    buffer = new TextBuffer(original);
    const applied = [];
    const textOrigins = [];
    const displayOrigins = [];
    const display = buffer.addDisplayLayer();
    display.getScreenLineCount();
    buffer.onDidChangeText((event) => textOrigins.push(event.origin));
    buffer.onDidApplyChanges((event) => applied.push(event));
    display.onDidChange((changes) =>
      displayOrigins.push(...changes.map((change) => change.origin)),
    );
    const prepare = spyOn(buffer.buffer, "prepareEdits").and.callThrough();

    buffer.setTextInIndependentRanges(
      Array.from({ length: 64 }, (_, row) => ({
        range: [
          [row, 0],
          [row, 0],
        ],
        text: "# ",
      })),
    );
    buffer.undo();
    expect(buffer.getText()).toBe(original);
    buffer.redo();

    expect(buffer.getText()).toBe("# row\n".repeat(64));
    expect(prepare.calls.count()).toBe(3);
    expect(textOrigins).toEqual(["edit", "undo", "redo"]);
    expect(applied.map((event) => event.origin)).toEqual(["edit", "undo", "redo"]);
    expect(applied.map((event) => event.changes.length)).toEqual([64, 64, 64]);
    expect(
      applied.every((event) => event.changes.every((change) => change.origin === event.origin)),
    ).toBe(true);
    expect(displayOrigins).toEqual(["edit", "undo", "redo"]);
  });

  it("does not leak history origins into edits made by a change observer", () => {
    buffer.append("d");
    const origins = [];
    buffer.onDidChangeText((event) => {
      origins.push(event.origin);
      if (event.origin === "undo") buffer.append("e");
    });

    buffer.undo();

    expect(origins).toEqual(["undo", "edit"]);
    expect(buffer.getText()).toBe("abce");
  });

  for (const withEdit of [false, true]) {
    it(`preserves ${withEdit ? "mixed" : "reload"} origins when a synchronous reload is nested in a transaction`, () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-reload-origin-"));
      const filePath = path.join(directory, "source.txt");
      let fileBuffer;
      try {
        fs.writeFileSync(filePath, "abc");
        fileBuffer = TextBuffer.loadSync(filePath);
        const marker = fileBuffer.markPosition([0, 3]);
        const textOrigins = [];
        const markerOrigins = [];
        fileBuffer.onDidChangeText((event) => textOrigins.push(event.origin));
        marker.onDidChange((event) => markerOrigins.push(event.origin));
        fs.writeFileSync(filePath, "abcd");
        fileBuffer.transact(() => {
          if (withEdit) {
            fileBuffer.append("e");
            fileBuffer.delete([
              [0, 3],
              [0, 4],
            ]);
          }
          fileBuffer.loadSync({ discardChanges: true });
        });

        const expected = withEdit ? "mixed" : "reload";
        expect(textOrigins).toEqual([expected]);
        expect(markerOrigins.length).toBeGreaterThan(0);
        expect(markerOrigins.every((origin) => origin === expected)).toBe(true);
        expect(fileBuffer.getText()).toBe("abcd");
      } finally {
        fileBuffer?.destroy();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  it("does not leak the reload origin into edits made by a change observer", async () => {
    const origins = [];
    const idle = stoppedChanging();
    buffer.onDidChangeText((event) => {
      origins.push(event.origin);
      if (event.origin === "reload") buffer.append("e");
    });
    source.text = "abcd";
    await buffer.load({ internal: true });
    const event = await idle;

    expect(origins).toEqual(["reload", "edit"]);
    expect(event.transactions.map((transaction) => transaction.origin)).toEqual(["reload", "edit"]);
    expect(buffer.getText()).toBe("abcde");
    expect(buffer.getFileState()).toBe("modified");
  });

  it("records nested applied-change edits in application order", async () => {
    const appliedOrigins = [];
    const idle = stoppedChanging();
    buffer.onDidApplyChanges((event) => {
      appliedOrigins.push(event.origin);
      if (event.origin === "reload") buffer.append("e");
    });
    source.text = "abcd";
    await buffer.load({ internal: true });
    const event = await idle;

    expect(appliedOrigins).toEqual(["reload", "edit"]);
    expect(event.transactions.map((transaction) => transaction.origin)).toEqual(["reload", "edit"]);
    expect(event.transactions.map((transaction) => transaction.changes[0].newText)).toEqual([
      "d",
      "e",
    ]);
  });

  it("retains a cancelled transaction after an earlier insertion", async () => {
    const idle = stoppedChanging();
    buffer.append("d");
    buffer.transact(() => {
      buffer.append("e");
      buffer.delete([
        [0, 4],
        [0, 5],
      ]);
    });
    const event = await idle;

    expect(event.transactions.length).toBe(2);
    expect(event.transactions[1].origin).toBe("edit");
    expect(event.transactions[1].changes).toEqual([]);
    expect(event.changes[0].newText).toBe("d");
  });

  it("freezes idle transaction snapshots", async () => {
    const idle = stoppedChanging();
    buffer.append("d");
    const event = await idle;

    expect(Object.isFrozen(event.transactions)).toBe(true);
    expect(Object.isFrozen(event.transactions[0])).toBe(true);
    expect(Object.isFrozen(event.transactions[0].changes)).toBe(true);
    expect(Object.isFrozen(event.transactions[0].changes[0])).toBe(true);
    expect(Object.isFrozen(event.transactions[0].changes[0].newRange)).toBe(true);
    expect(Object.isFrozen(event.transactions[0].changes[0].newRange.start)).toBe(true);
  });

  it("does not carry an empty display update's origin into a later reload", async () => {
    const displayLayer = buffer.addDisplayLayer();
    displayLayer.getScreenLineCount();
    const origins = [];
    displayLayer.onDidChange((changes) => origins.push(...changes.map((change) => change.origin)));
    displayLayer.didChange({
      start: TextBuffer.Point.ZERO,
      oldExtent: TextBuffer.Point.ZERO,
      newExtent: TextBuffer.Point.ZERO,
    });

    source.text = "abcd";
    await buffer.load({ internal: true });

    expect(origins).toEqual(["reload"]);
  });
});
