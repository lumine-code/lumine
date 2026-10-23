const TextEditor = require("../src/text-editor");
const TextBuffer = require("../src/text-buffer");
const NullLanguageMode = require("../src/null-language-mode");
const { setTimeout, clearTimeout } = require("node:timers");

describe("Indentation request cancellation", () => {
  let editor, survivor, buffer, mode, release, reject;

  beforeEach(() => {
    buffer = new TextBuffer({ text: "first\nsecond" });
    mode = new NullLanguageMode({ buffer });
    const pending = new Promise((resolve, rejectPromise) => {
      release = resolve;
      reject = rejectPromise;
    });
    Object.assign(mode, {
      useAsyncParsing: true,
      useAsyncIndent: true,
      atTransactionEnd: () => pending,
      atGrammarSettlement: () => pending,
      suggestedIndentForBufferRow: () => pending,
      suggestedIndentForEditedBufferRow: () => pending,
      suggestedIndentForBufferRows: () => pending,
      suggestedIndentForBufferRowsAtRows: () => pending,
    });
    buffer.setLanguageMode(mode);
    editor = new TextEditor({ buffer, tabLength: 2, softTabs: true });
    survivor = new TextEditor({ buffer, tabLength: 2, softTabs: true });
  });

  afterEach(() => {
    release(undefined);
    editor.destroy();
    survivor.destroy();
  });

  const operations = {
    transaction: () => editor.scheduleIndentAdjustment(),
    row: () => editor.autoIndentBufferRow(1),
    dedent: () => editor.autoDecreaseIndentForBufferRow(1),
    range: () => editor.autoIndentBufferRows(0, 1),
    sparse: () => editor.autoIndentBufferRowsAtRows([1]),
    publication: () => {
      mode.publicationPending = true;
      return editor.autoIndentBufferRows(0, 1);
    },
  };

  async function settlesWithoutProvider(promise) {
    let timer;
    try {
      return await Promise.race([
        promise.then(() => true),
        new Promise((resolve) => (timer = setTimeout(() => resolve(false), 50))),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  for (const [operation, invoke] of Object.entries(operations)) {
    for (const invalidation of ["close", "grammar replacement"]) {
      it(`releases a pending ${operation} after ${invalidation} without waiting for its provider`, async () => {
        const pending = invoke();
        expect(editor.hasPendingIndentation()).toBe(true);
        if (invalidation === "close") editor.destroy();
        else buffer.setLanguageMode(new NullLanguageMode({ buffer }));

        expect(await settlesWithoutProvider(pending)).toBe(true);
        expect(editor.hasPendingIndentation()).toBe(false);
        expect(buffer.isDestroyed()).toBe(false);
        expect(buffer.getText()).toBe("first\nsecond");
      });
    }
  }

  it("does not let a retired transaction block indentation in its replacement grammar", async () => {
    const retired = editor.scheduleIndentAdjustment();
    const replacement = new NullLanguageMode({ buffer });
    Object.assign(replacement, {
      useAsyncParsing: true,
      useAsyncIndent: true,
      atTransactionEnd: () =>
        Promise.resolve({ range: new TextBuffer.Range([1, 0], [1, 6]), autoIndentRequests: 1 }),
      suggestedIndentForBufferRows: () => new Map([[1, 1]]),
    });
    buffer.setLanguageMode(replacement);
    const settled = await settlesWithoutProvider(editor.whenGrammarSettled());
    expect(settled).toBe(true);
    if (!settled) return;

    expect(await settlesWithoutProvider(retired)).toBe(true);
    const current = editor.scheduleIndentAdjustment();
    expect(current).toBeDefined();
    await current;
    expect(buffer.getText()).toBe("first\n  second");
    expect(editor.hasPendingIndentation()).toBe(false);
  });

  it("leaves a shared provider available to the surviving editor", async () => {
    const retired = editor.autoIndentBufferRow(1);
    const current = survivor.autoIndentBufferRow(1);
    editor.destroy();

    expect(await settlesWithoutProvider(retired)).toBe(true);
    expect(survivor.hasPendingIndentation()).toBe(true);
    release(2);
    await current;
    expect(buffer.getText()).toBe("first\n    second");
    expect(survivor.hasPendingIndentation()).toBe(false);
  });

  it("owns a provider that replaces its language mode before returning its promise", async () => {
    const request = mode.suggestedIndentForBufferRow;
    mode.suggestedIndentForBufferRow = () => {
      buffer.setLanguageMode(new NullLanguageMode({ buffer }));
      return request();
    };

    expect(await settlesWithoutProvider(editor.autoIndentBufferRow(1))).toBe(true);
    expect(editor.hasPendingIndentation()).toBe(false);
    expect(buffer.getText()).toBe("first\nsecond");
  });

  it("consumes a late failure from a cancelled provider without reporting it", async () => {
    spyOn(console, "error");
    const retired = editor.scheduleIndentAdjustment();
    editor.destroy();
    expect(await settlesWithoutProvider(retired)).toBe(true);

    reject(new Error("Retired indentation failed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(console.error).not.toHaveBeenCalled();
    expect(buffer.getText()).toBe("first\nsecond");
  });
});
