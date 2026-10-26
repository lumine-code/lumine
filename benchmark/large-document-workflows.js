// Normal-application correctness scenarios. The host launcher owns the fresh
// profile, source fingerprints, external-file hash and process lifetime.
const TextBuffer = require("../src/text-buffer");
const fs = require("node:fs");
const path = require("node:path");
const clipboardBridge = require("../src/clipboard-bridge");
const { nativeImage } = require("electron");
const { MAX_STRING_LENGTH } = require("node:buffer").constants;
const {
  settle,
  snapshotDigest,
  inspectViewport,
  invariant,
} = require("./large-document-benchmark-spec");

function privateClipboard() {
  const originals = new Map();
  const texts = new Map();
  let items = [];
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      read: async () => items.slice(),
      write: async (nextItems) => {
        items = Array.from(nextItems);
        const plain = items.find((item) => item.types.includes("text/plain"));
        texts.set("clipboard", plain ? await (await plain.getType("text/plain")).text() : "");
        writes++;
      },
      readText: async () => texts.get("clipboard") || "",
      writeText: async (text) => {
        texts.set("clipboard", text);
        items = [];
        writes++;
      },
    },
  });
  const execCommand = document.execCommand;
  // Copy/cut commands first try native ClipboardEvents, bypassing the IPC
  // bridge. Disable that entry point as well; explicitly constructed events
  // below exercise the same handlers against a private DataTransfer.
  document.execCommand = function (command, ...args) {
    if (["copy", "cut", "paste"].includes(String(command).toLowerCase())) return false;
    return execCommand?.call(this, command, ...args);
  };
  let writes = 0;
  const replace = (name, method) => {
    originals.set(name, clipboardBridge[name]);
    clipboardBridge[name] = method;
  };
  replace("writeText", async (text, type = "clipboard") => {
    writes++;
    texts.set(type, text);
    if (type === "clipboard") items = [];
  });
  replace("readText", async (type = "clipboard") => texts.get(type) || "");
  replace("writeFindText", async (text) => texts.set("find", text));
  replace("readFindText", async () => texts.get("find") || "");
  replace("readImage", async () => nativeImage.createEmpty());
  replace("writeImage", async () => {
    throw new Error("WORKFLOW_IMAGE_WRITE_DISABLED");
  });
  return {
    writes: () => writes,
    restore: () => {
      if (navigatorDescriptor) Object.defineProperty(navigator, "clipboard", navigatorDescriptor);
      else delete navigator.clipboard;
      document.execCommand = execCommand;
      for (const [name, method] of originals) clipboardBridge[name] = method;
    },
  };
}

async function runBenchmark(config = {}) {
  invariant(
    !config.requireProduction || !lumine.window.isSpecMode(),
    "WORKFLOW_REQUIRES_NORMAL_APP",
  );
  const clipboard = privateClipboard();
  const report = {
    version: 1,
    status: "running",
    recordedAt: new Date().toISOString(),
    runtime: {
      specMode: lumine.window.isSpecMode(),
      ciEnvironmentPresent: Boolean(process.env.CI),
    },
    measurement:
      "Correctness workflows with independent content oracles and history checks. Diagnostic action durations include progress-report I/O and scheduling; use the separate performance benchmark for latency measurements.",
    clipboard:
      "Real editor/command/ClipboardEvent pipeline; private memory endpoint replaces OS clipboard IPC. User clipboard is neither read nor written.",
    packages: lumine.packages
      .getActivePackages()
      .map((pkg) => pkg.name)
      .sort(),
    settings: {},
    input: {},
    cases: [],
    asyncErrors: [],
    asyncErrorCount: 0,
  };
  let buffer,
    editor,
    pane,
    original,
    trace,
    originalReadOnly = false;
  const failure = (error) => ({
    code: /^[\w]{1,100}$/.test(error.code || "") ? error.code : error.name || "WORKFLOW_FAILURE",
    frames: String(error.stack || "")
      .split("\n")
      .slice(1, 4)
      .map((frame) => {
        const file = /([^/\\\s()]+\.js):(\d+):(\d+)/.exec(frame);
        return file ? { file: file[1], line: Number(file[2]), column: Number(file[3]) } : {};
      }),
  });
  const progress = () => {
    if (!config.progressFile) return;
    fs.writeFileSync(config.progressFile + ".next", JSON.stringify(report));
    fs.renameSync(config.progressFile + ".next", config.progressFile);
  };
  const errorEvent = (event) => {
    report.asyncErrorCount++;
    if (report.asyncErrors.length < 20)
      report.asyncErrors.push({
        case: report.phase,
        type: event.type,
        code:
          (event.error || event.reason)?.code || (event.error || event.reason)?.name || "UNKNOWN",
      });
  };
  window.addEventListener("error", errorEvent);
  window.addEventListener("unhandledrejection", errorEvent);
  const act = async (name, callback) => {
    const start = performance.now();
    const entry = { name, status: "running" };
    trace.push(entry);
    progress();
    try {
      const result = await callback();
      entry.status = "passed";
      return result;
    } catch (error) {
      entry.status = "failed";
      entry.failure = failure(error);
      throw error;
    } finally {
      entry.completeMs = performance.now() - start;
      progress();
    }
  };
  const command = (name, { allowUnavailable = false } = {}) =>
    act(name, async () => {
      invariant(
        allowUnavailable || lumine.commands.canDispatch(editor.getElement(), name),
        "WORKFLOW_COMMAND_UNAVAILABLE",
      );
      const result = lumine.commands.dispatch(editor.getElement(), name);
      invariant(
        allowUnavailable || (result != null && result !== false),
        "WORKFLOW_COMMAND_UNHANDLED",
      );
      await result;
    });
  const position = async (row, column = 0) =>
    act("place-cursor", async () => {
      editor.setCursorBufferPosition([row, column]);
      editor.scrollToCursorPosition();
      await settle();
    });
  const checkViewport = async () => {
    editor.scrollToCursorPosition();
    await settle();
    return inspectViewport(editor, editor.getElement().getComponent());
  };
  const reject = async (callback, codes) => {
    let rejected;
    try {
      await callback();
    } catch (error) {
      rejected = error;
    }
    invariant(
      rejected && codes.includes(rejected.code || rejected.name),
      "WORKFLOW_EXPECTED_REFUSAL",
    );
  };
  const scenario = async (name, callback) => {
    report.phase = name;
    trace = [];
    const entry = { name, status: "running", actions: trace };
    report.cases.push(entry);
    progress();
    try {
      editor.setReadOnly(false);
      if (!buffer.getTextSnapshot().equals(original)) buffer.setText(original);
      editor.setCursorBufferPosition([0, 0]);
      buffer.clearUndoStack();
      const checkpoint = buffer.createCheckpoint();
      const errorsBefore = report.asyncErrorCount;
      await callback();
      await settle();
      const changed = buffer.getTextSnapshot();
      const selections = editor.getSelectedBufferRanges().map((range) => range.serialize());
      if (!changed.equals(original)) {
        buffer.groupChangesSinceCheckpoint(checkpoint, { deleteCheckpoint: true });
        await command("core:undo");
        invariant(buffer.getTextSnapshot().equals(original), "WORKFLOW_UNDO_TEXT_MISMATCH");
        await command("core:redo");
        invariant(buffer.getTextSnapshot().equals(changed), "WORKFLOW_REDO_TEXT_MISMATCH");
        invariant(
          JSON.stringify(editor.getSelectedBufferRanges().map((range) => range.serialize())) ===
            JSON.stringify(selections),
          "WORKFLOW_REDO_SELECTION_MISMATCH",
        );
        await command("core:undo");
        invariant(buffer.getTextSnapshot().equals(original), "WORKFLOW_SECOND_UNDO_MISMATCH");
        entry.historyVerified = true;
      }
      entry.viewport = await checkViewport();
      invariant(report.asyncErrorCount === errorsBefore, "WORKFLOW_ASYNC_ERROR");
      entry.status = "passed";
    } catch (error) {
      entry.status = "failed";
      entry.failure = failure(error);
    } finally {
      editor.setReadOnly(false);
      if (!buffer.getTextSnapshot().equals(original)) buffer.setText(original);
      editor.setCursorBufferPosition([0, 0]);
      buffer.clearUndoStack();
      progress();
    }
  };
  try {
    const readyDeadline = Date.now() + 90000;
    while (!lumine.packages.hasActivatedInitialPackages()) {
      invariant(Date.now() < readyDeadline, "WORKFLOW_PACKAGE_ACTIVATION_TIMEOUT");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (const name of config.packages || []) await lumine.packages.activatePackage(name);
    report.packages = lumine.packages
      .getActivePackages()
      .map((pkg) => pkg.name)
      .sort();
    buffer = config.inputFile
      ? await TextBuffer.load(config.inputFile, { mustExist: true })
      : new TextBuffer({
          text: `Workflow header\n${"alpha beta gamma\n".repeat(config.generatedRows || 300100)}Workflow end`,
        });
    const denySave = () =>
      Promise.reject(
        Object.assign(new Error("WORKFLOW_INPUT_SAVE_DISABLED"), {
          code: "WORKFLOW_INPUT_SAVE_DISABLED",
        }),
      );
    buffer.save = buffer.saveAs = buffer.saveTo = denySave;
    lumine.grammars.assignLanguageMode(buffer, "text.plain.null-grammar");
    editor = lumine.workspace.buildTextEditor({ buffer, autoHeight: false, autoWidth: false });
    originalReadOnly = editor.isReadOnly();
    editor.setSoftWrapped(false);
    editor.update({ undoGroupingInterval: 0 });
    pane = lumine.workspace.getActivePane();
    pane.addItem(editor);
    pane.activateItem(editor);
    editor.getElement().setUpdatedSynchronously(false);
    editor.getElement().focus();
    await settle();
    original = buffer.getTextSnapshot();
    report.input = {
      units: original.length,
      lines: original.lineCount,
      snapshotUtf16leSha256: await snapshotDigest(original),
    };
    report.settings = {
      encoding: buffer.getEncoding(),
      grammar: editor.getGrammar().scopeName,
      largeDocumentView: editor.usesLargeDocumentView(),
    };
    const last = buffer.getLastRow();
    const rows = [0, Math.floor(last / 2), Math.max(0, last - 3)];
    const assertInsertion = (offset, inserted, base = original) =>
      invariant(
        buffer.getTextSnapshot().equals(base.replace(offset, offset, inserted)),
        "WORKFLOW_EXPECTED_TEXT_MISMATCH",
      );
    const endingAt = (row) =>
      buffer.getPreferredLineEnding() ||
      buffer.lineEndingForRow(row) ||
      buffer.lineEndingForRow(row - 1) ||
      "\n";

    await scenario("private-clipboard-protocol-boundaries", async () => {
      await act("async-clipboard-text", () => navigator.clipboard.writeText("WF_PRIVATE_TEXT"));
      invariant(
        (await lumine.clipboard.read()) === "WF_PRIVATE_TEXT",
        "WORKFLOW_PRIVATE_TEXT_ENDPOINT",
      );
      await act("async-custom-clipboard-format", () =>
        lumine.clipboard.writeNativeData("WF_CUSTOM", "application/lumine-workflow", { value: 42 }),
      );
      invariant(
        (await lumine.clipboard.readNativeData("application/lumine-workflow"))?.value === 42,
        "WORKFLOW_PRIVATE_CUSTOM_ENDPOINT",
      );
      invariant((await lumine.clipboard.read()) === "WF_CUSTOM", "WORKFLOW_PRIVATE_CUSTOM_TEXT");
    });

    await scenario("navigation-and-reversed-whole-selection", async () => {
      for (let repeat = 0; repeat < 4; repeat++) {
        await command("core:move-to-bottom");
        invariant(
          editor.getCursorBufferPosition().isEqual(buffer.getEndPosition()),
          "WORKFLOW_END_POSITION",
        );
        await settle();
        inspectViewport(editor, editor.getElement().getComponent());
        await command("core:select-to-top");
        invariant(
          editor.getSelectedBufferRange().isEqual(buffer.getRange()),
          "WORKFLOW_REVERSE_SELECT_ALL",
        );
        invariant(editor.getLastSelection().isReversed(), "WORKFLOW_SELECTION_DIRECTION");
        await command("core:move-to-top");
        invariant(editor.getCursorBufferPosition().isEqual([0, 0]), "WORKFLOW_START_POSITION");
        await command("core:select-to-bottom");
        invariant(
          editor.getSelectedBufferRange().isEqual(buffer.getRange()),
          "WORKFLOW_FORWARD_SELECT_ALL",
        );
      }
    });

    for (const [index, row] of rows.entries()) {
      await scenario(`copy-paste-${index}`, async () => {
        await position(row);
        const desiredStart = original.lineStart(row);
        const range = buffer.clipRange([
          original.positionAt(desiredStart),
          original.positionAt(Math.min(original.length, desiredStart + (index === 1 ? 65537 : 31))),
        ]);
        const start = original.offsetAt(range.start),
          end = original.offsetAt(range.end);
        await act("select-bounded-range", () =>
          editor.setSelectedBufferRange(range, { reversed: index % 2 === 1 }),
        );
        const selected = original.slice(start, end);
        await command("core:copy");
        const copied = await lumine.clipboard.readWithMetadata();
        invariant(
          copied.text === lumine.clipboard.normalizeText(selected),
          "WORKFLOW_COPY_CONTENT",
        );
        await position(row);
        const target = buffer.characterIndexForPosition(editor.getCursorBufferPosition());
        const ending =
          buffer.getPreferredLineEnding() ||
          buffer.lineEndingForRow(row) ||
          buffer.lineEndingForRow(row - 1);
        await act("paste-without-indent", () => editor.pasteText({ autoIndent: false }));
        const expected = ending ? copied.text.replace(/\r\n|\r|\n/g, ending) : copied.text;
        const actual = buffer.getTextSnapshot();
        invariant(actual.length === original.length + expected.length, "WORKFLOW_PASTE_LENGTH");
        invariant(
          actual.slice(target, target + expected.length) === expected,
          "WORKFLOW_PASTE_CONTENT",
        );
        invariant(
          actual.subtext(0, target).equals(original.subtext(0, target)) &&
            actual.subtext(target + expected.length).equals(original.subtext(target)),
          "WORKFLOW_PASTE_OUTSIDE_RANGE",
        );
      });

      await scenario(`cut-and-paste-${index}`, async () => {
        await position(row);
        const desiredStart = original.lineStart(row);
        const range = buffer.clipRange([
          original.positionAt(desiredStart),
          original.positionAt(Math.min(original.length, desiredStart + 17)),
        ]);
        const start = original.offsetAt(range.start),
          end = original.offsetAt(range.end);
        await act("select-cut-range", () => editor.setSelectedBufferRange(range));
        await command("core:cut");
        invariant(buffer.getLength() === original.length - (end - start), "WORKFLOW_CUT_LENGTH");
        invariant(
          buffer.getTextSnapshot().equals(original.replace(start, end, "")),
          "WORKFLOW_CUT_CONTENT",
        );
        await position(Math.min(row + 1, buffer.getLastRow()));
        const cut = buffer.getTextSnapshot();
        const target = cut.offsetAt(editor.getCursorBufferPosition());
        const copied = await lumine.clipboard.readWithMetadata();
        const ending = endingAt(editor.getCursorBufferPosition().row);
        await act("paste-cut-text-without-indent", () => editor.pasteText({ autoIndent: false }));
        assertInsertion(target, copied.text.replace(/\r\n|\r|\n/g, ending), cut);
      });
    }

    await scenario("native-clipboard-event-roundtrip", async () => {
      await position(rows[1]);
      const range = [
        [rows[1], 0],
        [rows[1], Math.min(8, buffer.lineLengthForRow(rows[1]))],
      ];
      editor.setSelectedBufferRange(range);
      const expected = editor.getSelectedText();
      const data = new DataTransfer();
      const input = editor.getElement().getComponent().refs.cursorsAndInput.refs.hiddenInput;
      const copy = new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      });
      await act("dispatch-copy-event", () => input.dispatchEvent(copy));
      invariant(copy.defaultPrevented, "WORKFLOW_COPY_EVENT_NOT_HANDLED");
      invariant(
        data.getData("text/plain") === lumine.clipboard.normalizeText(expected),
        "WORKFLOW_EVENT_COPY_CONTENT",
      );
      await position(rows[1]);
      const before = buffer.getLength();
      const revision = buffer.getTextRevision();
      const autoIndentOnPaste = editor.shouldAutoIndentOnPaste();
      editor.update({ autoIndentOnPaste: false });
      const paste = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      });
      try {
        await act("dispatch-paste-event", () => input.dispatchEvent(paste));
        const deadline = Date.now() + 5000;
        while (buffer.getTextRevision() === revision && expected.length) {
          invariant(Date.now() < deadline, "WORKFLOW_PASTE_EVENT_TIMEOUT");
          await settle();
        }
        await settle();
      } finally {
        editor.update({ autoIndentOnPaste });
      }
      invariant(
        paste.defaultPrevented && buffer.getLength() === before + expected.length,
        "WORKFLOW_PASTE_EVENT_CONTENT",
      );
    });

    await scenario("multi-cursor-copy-distributed-paste", async () => {
      const ranges = rows.map((row) => [
        [row, 0],
        [row, Math.min(3, buffer.lineLengthForRow(row))],
      ]);
      editor.setSelectedBufferRanges(ranges);
      const contents = ranges.map((range) => buffer.getTextInRange(range));
      await command("core:copy");
      const copied = await lumine.clipboard.readWithMetadata();
      invariant(copied.metadata?.selections?.length === 3, "WORKFLOW_MULTI_COPY_METADATA");
      editor.setSelectedBufferRanges(
        rows.map((row) => [
          [row, 0],
          [row, 0],
        ]),
      );
      await act("distributed-paste", () => editor.pasteText({ autoIndent: false }));
      invariant(
        buffer.getLength() ===
          original.length + contents.reduce((sum, text) => sum + text.length, 0),
        "WORKFLOW_MULTI_PASTE_LENGTH",
      );
      for (let index = 0; index < rows.length; index++)
        invariant(
          buffer.getTextInRange([
            [rows[index], 0],
            [rows[index], contents[index].length],
          ]) === contents[index],
          "WORKFLOW_MULTI_PASTE_CONTENT",
        );
    });

    if (original.length > MAX_STRING_LENGTH) {
      await scenario("oversized-native-copy-and-cut-refusal", async () => {
        await command("core:select-all");
        const beforeWrites = clipboard.writes();
        await reject(() => editor.copySelectedText(), ["ERR_CLIPBOARD_TEXT_LIMIT"]);
        await reject(() => editor.cutSelectedText(), ["ERR_CLIPBOARD_TEXT_LIMIT"]);
        invariant(clipboard.writes() === beforeWrites, "WORKFLOW_OVERSIZED_CLIPBOARD_WRITE");
        invariant(buffer.getTextSnapshot().equals(original), "WORKFLOW_OVERSIZED_CUT_MUTATED");
      });
    }

    await scenario("unicode-edit-burst-backspace-delete", async () => {
      await position(rows[1]);
      const offset = original.lineStart(rows[1]),
        ending = endingAt(rows[1]);
      let expected = "";
      for (let index = 0; index < 12; index++) {
        const text = `α😀 e\u0301\t${index}`;
        await act("insert-unicode", () => editor.insertText(text, { autoIndent: false }));
        expected += text;
        assertInsertion(offset, expected);
        await command("editor:newline");
        assertInsertion(offset, expected + ending);
        await command("core:backspace");
        assertInsertion(offset, expected);
        await command("editor:newline");
        expected += ending;
        assertInsertion(offset, expected);
      }
      await command("core:move-left");
      await command("core:delete");
      assertInsertion(offset, expected.slice(0, -ending.length));
    });

    for (const action of [
      "editor:duplicate-lines",
      "editor:move-line-up",
      "editor:move-line-down",
      "editor:upper-case",
      "editor:lower-case",
      "editor:join-lines",
      "editor:indent-selected-rows",
      "editor:outdent-selected-rows",
    ]) {
      await scenario(action, async () => {
        const row = Math.max(1, rows[1]);
        await position(row);
        editor.setSoftTabs(true);
        editor.setTabLength(2);
        const ending = endingAt(row);
        const lines = ["  Alpha ΟΣ😀 one", "    Beta two", "gamma three"];
        const island = lines.join(ending) + ending;
        const offset = original.lineStart(row);
        await act("insert-controlled-lines", () =>
          buffer.setTextInRange(
            [
              [row, 0],
              [row, 0],
            ],
            island,
            { normalizeLineEndings: false },
          ),
        );
        let expected;
        switch (action) {
          case "editor:duplicate-lines":
            expected = island + island;
            break;
          case "editor:move-line-up":
            expected = [lines[1], lines[0], lines[2]].join(ending) + ending;
            break;
          case "editor:move-line-down":
            expected = [lines[0], lines[2], lines[1]].join(ending) + ending;
            break;
          case "editor:upper-case":
            expected = island.toUpperCase();
            break;
          case "editor:lower-case":
            expected = island.toLowerCase();
            break;
          case "editor:join-lines":
            expected = lines[0] + " " + lines[1].trimStart() + " " + lines[2] + ending;
            break;
          case "editor:indent-selected-rows":
            expected = lines.map((line) => "  " + line).join(ending) + ending;
            break;
          case "editor:outdent-selected-rows":
            expected = lines.map((line) => line.replace(/^ {1,2}/, "")).join(ending) + ending;
            break;
        }
        const move = action.includes("move-line");
        editor.setSelectedBufferRange([
          [row + (move ? 1 : 0), 0],
          action === "editor:join-lines" ? [row + 2, lines[2].length] : [row + (move ? 2 : 3), 0],
        ]);
        const autoIndent = editor.shouldAutoIndent();
        if (move) editor.update({ autoIndent: false });
        try {
          await command(action);
        } finally {
          if (move) editor.update({ autoIndent });
        }
        assertInsertion(offset, expected);
      });
    }

    await scenario("search-replace-and-cancel-at-current-revision", async () => {
      await position(rows[1]);
      const offset = original.lineStart(rows[1]),
        ending = endingAt(rows[1]);
      await act("insert-search-fixture", () =>
        editor.insertText("WF_NEEDLE_01 WF_NEEDLE_02 WF_NEEDLE_03\n", { autoIndent: false }),
      );
      const session = buffer.createSearch(/WF_NEEDLE_0[123]/g);
      const result = await act("collect-exact-count", () => session.collect({ limit: 2 }));
      invariant(session.count === 3 && session.complete, "WORKFLOW_SEARCH_EXACT_COUNT");
      invariant(result.ranges.length <= 2, "WORKFLOW_SEARCH_PRESENTATION_BOUND");
      await act("replace-all", () =>
        buffer.replaceAllMatches(/WF_NEEDLE_0([123])/g, "WF_REPLACED_$1"),
      );
      const replaced = buffer.createSearch(/WF_REPLACED_[123]/g);
      await replaced.collect({ limit: 4 });
      invariant(replaced.count === 3, "WORKFLOW_REPLACE_COUNT");
      assertInsertion(offset, "WF_REPLACED_1 WF_REPLACED_2 WF_REPLACED_3" + ending);
      const controller = new AbortController();
      const cancelled = buffer.createSearch(/./g, { signal: controller.signal });
      await reject(
        () => cancelled.collect({ limit: 4, onProgress: () => controller.abort() }),
        ["AbortError"],
      );
      invariant(!cancelled.complete, "WORKFLOW_CANCELLED_COUNT_COMPLETE");
    });

    await scenario("read-only-refusal-preserves-document", async () => {
      await position(rows[1]);
      editor.setReadOnly(true);
      await settle();
      await command("editor:newline", { allowUnavailable: true });
      await command("core:delete", { allowUnavailable: true });
      invariant(buffer.getTextSnapshot().equals(original), "WORKFLOW_READ_ONLY_MUTATION");
      editor.setReadOnly(false);
    });

    await scenario("shared-buffer-split-edit-history", async () => {
      const split = editor.copy();
      const splitPane = pane.splitRight({ items: [split] });
      try {
        splitPane.activateItem(split);
        split.setCursorBufferPosition([rows[1], 0]);
        const offset = original.lineStart(rows[1]),
          ending = endingAt(rows[1]);
        await act("insert-in-split", () => split.insertText("WF_SPLIT\n", { autoIndent: false }));
        invariant(
          split.getBuffer() === buffer && editor.getBuffer() === buffer,
          "WORKFLOW_SPLIT_BUFFER_IDENTITY",
        );
        assertInsertion(offset, "WF_SPLIT" + ending);
      } finally {
        splitPane.removeItem(split);
        split.destroy();
        splitPane.destroy();
        pane.activate();
        pane.activateItem(editor);
        editor.getElement().focus();
      }
    });

    if (config.scratchDirectory)
      await scenario("stream-save-reload-temporary-copy", async () => {
        await fs.promises.mkdir(config.scratchDirectory, { recursive: true });
        const directory = await fs.promises.mkdtemp(path.join(config.scratchDirectory, "copy-"));
        const file = path.join(directory, "workflow-copy.txt");
        invariant(
          !config.inputFile || path.resolve(file) !== path.resolve(config.inputFile),
          "WORKFLOW_COPY_PATH_COLLISION",
        );
        let copy, loaded;
        try {
          copy = new TextBuffer();
          lumine.grammars.assignLanguageMode(copy, "text.plain.null-grammar");
          copy.setTextInRange(copy.getRange(), original, { normalizeLineEndings: false });
          copy.setPath(file);
          copy.setTextInRange(
            [copy.getEndPosition(), copy.getEndPosition()],
            "\nWF_SAVED_α😀\r\n",
            { normalizeLineEndings: false },
          );
          const saved = copy.getTextSnapshot();
          await act("save-temporary-copy", () => copy.save());
          invariant(copy.getFileState() === "unmodified", "WORKFLOW_SAVED_COPY_DIRTY");
          loaded = await act("load-temporary-copy", () =>
            TextBuffer.load(file, { mustExist: true }),
          );
          invariant(loaded.getTextSnapshot().equals(saved), "WORKFLOW_SAVE_RELOAD_CONTENT");
          invariant(
            buffer.getTextSnapshot().equals(original),
            "WORKFLOW_COPY_SAVE_CHANGED_ORIGINAL",
          );
          await act("edit-temporary-copy", () => loaded.insert([0, 0], "WF_UNSAVED"));
          await act("reload-discards-temporary-edit", () => loaded.reload());
          invariant(loaded.getTextSnapshot().equals(saved), "WORKFLOW_RELOAD_CONTENT");
        } finally {
          copy?.destroy();
          loaded?.destroy();
          await fs.promises.unlink(file).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
          await fs.promises.rmdir(directory);
        }
      });

    invariant(buffer.getTextSnapshot().equals(original), "WORKFLOW_FINAL_SOURCE_CHANGED");
    report.actionCount = report.cases.reduce((count, entry) => count + entry.actions.length, 0);
    report.passedCases = report.cases.filter((entry) => entry.status === "passed").length;
    report.failedCases = report.cases.filter((entry) => entry.status === "failed").length;
    report.status = report.failedCases || report.asyncErrorCount ? "failed" : "complete";
    report.phase = "complete";
    return report;
  } catch (error) {
    report.status = "failed";
    report.failure = failure(error);
    return report;
  } finally {
    window.removeEventListener("error", errorEvent);
    window.removeEventListener("unhandledrejection", errorEvent);
    if (editor) {
      editor.setReadOnly(originalReadOnly);
      pane?.removeItem(editor);
      editor.destroy();
    }
    if (buffer && !buffer.isDestroyed()) buffer.destroy();
    // The isolated normal window exits next. Keep its endpoints private during
    // asynchronous package teardown as well; reusable spec callers restore.
    if (!config.requireProduction) clipboard.restore();
  }
}

module.exports = { runBenchmark };
