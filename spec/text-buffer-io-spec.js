const fs = require("@lumine-code/fs-plus");
const path = require("path");
const { Writable, Transform } = require("stream");
const temp = require("./text-buffer-helpers/temp");
const { Disposable } = require("@lumine-code/event-kit");
const Point = require("../src/point");
const Range = require("../src/range");
const TextBuffer = require("../src/text-buffer");
const TextBufferFile = require("../src/text-buffer-file");
const { TextBuffer: NativeTextBuffer } = require("@lumine-code/superstring");
const fsAdmin = require("@lumine-code/fs-admin");
const FileState = require("../src/file-state");

const winattr = require("winattr");

process.on("unhandledRejection", console.error);

async function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("TextBuffer IO", () => {
  let buffer, buffer2;

  // These specs use real timers (`wait`, the buffer's debounced file-change
  // handling). Lumine's harness installs a fake clock by default.
  beforeEach(() => jasmine.useRealClock());

  afterEach(async () => {
    if (buffer) buffer.destroy();
    if (buffer2) buffer2.destroy();

    // Destroying a buffer disposes its own file watcher; give the worker a
    // tick to tear the disposed watchers down.
    await wait(50);
  });

  describe(".load", () => {
    it("resolves with a buffer containing the given file's text", async (done) => {
      const filePath = temp.openSync("lumine").path;
      fs.writeFileSync(filePath, "abc");

      buffer = await TextBuffer.load(filePath);
      expect(buffer.getText()).toBe("abc");
      expect(buffer.getFileState()).toBe(FileState.UNMODIFIED);
      expect(buffer.undo()).toBe(false);
      expect(buffer.getText()).toBe("abc");
      done();
    });

    it("resolves with an empty buffer if there is no file at the given path", async (done) => {
      const filePath = "does-not-exist.txt";
      buffer = await TextBuffer.load(filePath);
      expect(buffer.getText()).toBe("");
      expect(buffer.getFileState()).toBe(FileState.UNMODIFIED);
      expect(buffer.undo()).toBe(false);
      expect(buffer.getText()).toBe("");
      done();
    });

    it("rejects if the given path is a directory", async (done) => {
      const dirPath = temp.mkdirSync("lumine");
      try {
        await TextBuffer.load(dirPath);
      } catch (error) {
        expect(error.code).toBe(process.platform === "win32" ? "EACCES" : "EISDIR");
        done();
      }
    });

    it("optionally rejects with an ENOENT if there is no file at the given path", async (done) => {
      const filePath = "does-not-exist.txt";
      try {
        await TextBuffer.load(filePath, { mustExist: true });
      } catch (error) {
        expect(error.code).toBe("ENOENT");
        done();
      }
    });

    describe("when a custom File object is given in place of the file path", () => {
      it("loads the buffer using the file's createReadStream method", async (done) => {
        const filePath = temp.openSync("lumine").path;
        fs.writeFileSync(filePath, "abc\ndef");

        buffer = await TextBuffer.load(new ReverseCaseFile(filePath));
        expect(buffer.getText()).toBe("ABC\nDEF");
        expect(buffer.getFileState()).toBe(FileState.UNMODIFIED);
        done();
      });
    });
  });

  describe(".loadSync", () => {
    it("returns a buffer containing the given file's text", () => {
      const filePath = temp.openSync("lumine").path;
      fs.writeFileSync(filePath, "abc");

      buffer = TextBuffer.loadSync(filePath);
      expect(buffer.getText()).toBe("abc");
      expect(buffer.getFileState()).toBe(FileState.UNMODIFIED);
    });

    it("returns an empty buffer if the file does not exist", () => {
      buffer = TextBuffer.loadSync("/this/does/not/exist");
      expect(buffer.getText()).toBe("");
    });

    it("throws EISDIR if the path is a directory", () => {
      const dirPath = temp.mkdirSync("lumine");
      try {
        TextBuffer.loadSync(dirPath);
        expect("Did not fail with EISDIR").toBeUndefined();
      } catch (e) {
        expect(e.code).toBe(process.platform === "win32" ? "EACCES" : "EISDIR");
      }
    });

    it("optionally throws ENOENT if there is no file at the given path", () => {
      try {
        TextBuffer.loadSync("/does-not-exist.txt", { mustExist: true });
        expect("Did not fail with mustExist: true").toBeUndefined();
      } catch (e) {
        expect(e.code).toBe("ENOENT");
      }
    });
  });

  describe(".reload", () => {
    let filePath;

    beforeEach(async (done) => {
      filePath = temp.openSync("lumine").path;
      fs.writeFileSync(filePath, "abcdefg");
      buffer = await TextBuffer.load(filePath);
      done();
    });

    it("it updates the buffer even if it is modified", async (done) => {
      buffer.delete([
        [0, 0],
        [0, 2],
      ]);
      expect(buffer.getText()).toBe("cdefg");

      const marker = buffer.markRange([
        [0, 3],
        [0, 4],
      ]);

      fs.writeFileSync(filePath, "123abcdefg", "utf8");

      const events = [];
      buffer.onWillReload(() => events.push("will-reload"));
      buffer.onDidReload(() => events.push("did-reload"));

      await buffer.reload();
      expect(events).toEqual(["will-reload", "did-reload"]);
      expect(buffer.getText()).toBe("123abcdefg");
      expect(marker.getRange()).toEqual(Range(Point(0, 8), Point(0, 9)));

      buffer.undo();
      expect(buffer.getText()).toBe("cdefg");
      expect(marker.getRange()).toEqual(Range(Point(0, 3), Point(0, 4)));
      done();
    });

    it("notifies decoration layers and display layers of the change", async (done) => {
      fs.writeFileSync(filePath, "abcdefGHIJK", "utf8");

      const events = [];

      const displayLayer = buffer.addDisplayLayer();
      displayLayer.onDidChange((event) => events.push(["display-layer", event]));

      buffer.setLanguageMode({
        bufferDidChange({ oldRange, newRange, oldText, newText }) {
          events.push(["decoration-layer", { oldRange, newRange, oldText, newText }]);
        },

        bufferDidFinishTransaction() {},

        onDidChangeHighlighting() {
          return { dispose() {} };
        },
      });

      await buffer.reload();
      expect(events).toEqual([
        [
          "decoration-layer",
          {
            oldRange: Range(Point(0, 6), Point(0, 7)),
            newRange: Range(Point(0, 6), Point(0, 11)),
            oldText: "g",
            newText: "GHIJK",
          },
        ],
        [
          "display-layer",
          [
            {
              oldRange: Range(Point(0, 0), Point(1, 0)),
              newRange: Range(Point(0, 0), Point(1, 0)),
            },
          ],
        ],
      ]);
      done();
    });

    it("clears the contents of the buffer when the file doesn\t exist", async (done) => {
      buffer.delete([
        [0, 0],
        [0, 2],
      ]);

      const events = [];
      buffer.onWillReload(() => events.push("will-reload"));
      buffer.onDidReload(() => events.push("did-reload"));

      buffer.setPath("does-not-exist");
      await buffer.reload();
      expect(events).toEqual(["will-reload", "did-reload"]);
      expect(buffer.getText()).toBe("");
      expect(buffer.getFileState()).toBe(FileState.REMOVED);

      buffer.undo();
      expect(buffer.getText()).toBe("cdefg");
      expect(buffer.getFileState()).toBe(FileState.REMOVED);
      done();
    });

    it("emits reload events even if nothing has changed", async (done) => {
      const events = [];
      buffer.onWillReload((_event) => events.push("will-reload"));
      buffer.onDidReload((_event) => events.push("did-reload"));
      await buffer.reload();
      expect(events).toEqual(["will-reload", "did-reload"]);
      done();
    });

    it("gracefully handles edits performed in onDidChange listeners that are called on reload", async (done) => {
      fs.writeFileSync(filePath, "abcdXefg", "utf8");

      {
        const subscription = buffer.onDidChange((event) => {
          subscription.dispose();

          // Legacy properties
          expect(event.oldRange).toEqual(Range(Point(0, 4), Point(0, 4)));
          expect(event.newRange).toEqual(Range(Point(0, 4), Point(0, 5)));
          expect(event.oldText).toBe("");
          expect(event.newText).toBe("X");

          expect(event.changes.length).toBe(1);
          expect(event.changes[0].oldText).toBe("");
          expect(event.changes[0].newText).toBe("X");
          buffer.setText("");
        });
      }

      {
        const subscription = buffer.onDidStopChanging(({ changes }) => {
          subscription.dispose();

          expect(changes.length).toBe(1);
          expect(changes[0].oldText).toBe("abcdefg");
          expect(changes[0].newText).toBe("");

          expect(buffer.getText()).toBe("");

          buffer.undo();
          expect(buffer.getText()).toBe("abcdXefg");

          buffer.undo();
          expect(buffer.getText()).toBe("abcdefg");

          done();
        });
      }

      buffer.reload();
    });
  });

  describe(".save", () => {
    let filePath;

    beforeEach(() => {
      const tempDir = temp.mkdirSync();
      filePath = path.join(tempDir, "temp.txt");
      fs.writeFileSync(filePath, "");
      buffer = new TextBuffer();
      buffer.setPath(filePath);
    });

    it("saves the contents of the buffer to the path", async (done) => {
      buffer.setText("Buffer contents");
      await buffer.save();
      expect(fs.readFileSync(filePath, "utf8")).toEqual("Buffer contents");
      expect(buffer.undo()).toBe(true);
      expect(buffer.getText()).toBe("");
      done();
    });

    it("does not emit a change event", async (done) => {
      buffer.setText("Buffer contents");
      expect(buffer.getFileState()).toBe(FileState.MODIFIED);

      const changeEvents = [];
      buffer.onWillChange(() => changeEvents.push(["will-change"]));
      buffer.onDidChange((event) => changeEvents.push(["did-change", event]));

      await buffer.save();
      expect(buffer.getFileState()).toBe(FileState.UNMODIFIED);

      setTimeout(() => {
        expect(changeEvents).toEqual([]);
        done();
      }, 250);
    });

    it("does not emit a conflict event due to the save", async () => {
      const events = [];
      buffer.onDidChangeFileState((fileState) => {
        if (fileState === FileState.CONFLICTED) events.push(fileState);
      });

      buffer.setText("Buffer contents");
      // Modify the file after the save has been asynchronously initiated
      buffer.onDidSave(() => buffer.append("!"));
      await buffer.save();

      // Wait long enough for the file watcher to (not) react to our own writes.
      await wait(buffer.fileChangeDelay + 250);
      expect(events.length).toBe(0);
    });

    it("does not emit a reload event due to the save", async () => {
      const events = [];
      buffer.onWillReload((event) => events.push(event));
      buffer.onDidReload((event) => events.push(event));

      buffer.setText("Buffer contents");
      await buffer.save();

      // Wait long enough for the file watcher to (not) react to our own write.
      await wait(buffer.fileChangeDelay + 250);
      expect(events.length).toBe(0);
    });

    it("notifies ::onWillSave and ::onDidSave observers", async (done) => {
      const events = [];
      buffer.onWillSave((event) =>
        events.push(["will-save", event, fs.readFileSync(filePath, "utf8")]),
      );
      buffer.onDidSave((event) =>
        events.push(["did-save", event, fs.readFileSync(filePath, "utf8")]),
      );

      buffer.setText("Buffer contents");
      await buffer.save();
      const path = buffer.getPath();
      expect(events).toEqual([
        ["will-save", { path }, ""],
        ["did-save", { path }, "Buffer contents"],
      ]);
      done();
    });

    it("waits for any promises returned by ::onWillSave observers", async (done) => {
      buffer.onWillSave(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              buffer.append(" - updated");
              resolve();
            }, 50);
          }),
      );

      buffer.setText("Buffer contents");
      await buffer.save();
      expect(fs.readFileSync(filePath, "utf8")).toBe("Buffer contents - updated");
      done();
    });

    describe("when the buffer is destroyed before the save completes", () => {
      it("saves the current contents of the buffer to the path", (done) => {
        buffer.setText("hello\n");
        buffer.save().then(() => {
          expect(buffer.getText()).toBe("");
          expect(fs.readFileSync(filePath, "utf8")).toBe("hello\n");
          done();
        });
        buffer.destroy();
      });
    });

    describe("when a conflict is created", () => {
      beforeEach(async (done) => {
        buffer.setText("a");
        await buffer.save();
        await buffer.getFileWatchStartPromise();
        buffer.setText("ab");
        // The watch-start promise confirms the watch handle exists, but events
        // can still be dropped in its start-up window. Retry the conflicting
        // write (with fresh content each attempt) until the conflict event
        // proves the watch is delivering.
        let probeCount = 0;
        let probeTimer;
        const subscription = buffer.onDidChangeFileState((fileState) => {
          if (fileState === FileState.CONFLICTED) {
            subscription.dispose();
            clearInterval(probeTimer);
            done();
          }
        });
        const probe = () => {
          probeCount++;
          fs.writeFileSync(buffer.getPath(), `c${probeCount}`);
        };
        probeTimer = setInterval(probe, 500);
        probe();
      });

      it("no longer reports being in conflict when the buffer is saved again", async (done) => {
        expect(buffer.getFileState()).toBe(FileState.CONFLICTED);
        await buffer.save();
        expect(buffer.getFileState()).toBe(FileState.UNMODIFIED);
        // Ensure we don't get flipped into conflicted status after the
        // `onDidChange` handler comes through…
        await wait(1000);
        expect(buffer.getFileState()).toBe(FileState.UNMODIFIED);
        buffer.setText("q");
        // …and the buffer is modified again.
        expect(buffer.getFileState()).toBe(FileState.MODIFIED);
        done();
      });
    });

    describe("when the buffer has no path", () => {
      it("throws an exception", (done) => {
        buffer2 = new TextBuffer();
        buffer2.setText("hi");
        buffer2.save().catch((error) => {
          expect(error.message).toMatch(/Can't save a buffer with no file/);
          done();
        });
      });
    });

    describe("when the buffer is backed by a custom File object instead of a path", () => {
      beforeEach(() => {
        buffer.destroy();
        buffer = new TextBuffer();
        buffer.setFile(new ReverseCaseFile(filePath));
      });

      it("saves the contents of the buffer to the given file", async (done) => {
        buffer.setText("abc DEF ghi JKL\n".repeat(10 * 1024));
        await buffer.save();
        expect(fs.readFileSync(filePath, "utf8")).toBe("ABC def GHI jkl\n".repeat(10 * 1024));
        expect(buffer.getFileState()).toBe(FileState.UNMODIFIED);
        done();
      });

      it("does not emit a conflict event due to the save", async () => {
        const events = [];
        buffer.onDidChangeFileState((fileState) => {
          if (fileState === FileState.CONFLICTED) events.push(fileState);
        });

        // `ReverseCaseFile` uses `fs.watch` to set up file-watching. This
        // built-in method is fast, but not instantaneous. Let the buffer's
        // watch arm before the save writes the file, or there is no change
        // notification for this spec to prove is harmless.
        await wait(process.env.CI ? 500 : 200);

        buffer.setText("Buffer contents");
        // Modify the buffer after the save has been asynchronously initiated
        buffer.onDidSave(() => buffer.append("!"));
        await buffer.save();

        // Wait long enough for the file watcher to (not) react to our own write.
        await wait(buffer.fileChangeDelay + 250);
        expect(events.length).toBe(0);
      });
    });

    if (process.platform !== "win32")
      describe("when a permission error occurs (not Windows)", () => {
        beforeEach(() => {
          const save = NativeTextBuffer.prototype.save;

          spyOn(NativeTextBuffer.prototype, "save").and.callFake(function (destination, encoding) {
            if (destination === filePath) {
              return Promise.reject(
                Object.assign(new Error("Permission denied"), { code: "EACCES" }),
              );
            }

            return save.call(this, destination, encoding);
          });
        });

        it("requests escalated privileges to save the file", async (done) => {
          spyOn(fsAdmin, "createWriteStream").and.callFake(() => fs.createWriteStream(filePath));

          buffer.setText("Buffer contents\n".repeat(100));

          await buffer.save();
          expect(fs.readFileSync(filePath, "utf8")).toEqual(buffer.getText());
          expect(fsAdmin.createWriteStream).toHaveBeenCalled();
          expect(buffer.outstandingSaveCount).toBe(0);
          done();
        });

        it("rejects if writing to the file fails", async (done) => {
          const stream = new Writable({
            write(chunk, encoding, callback) {
              process.nextTick(() => callback(new Error("Could not write to stream")));
            },
          });

          spyOn(fsAdmin, "createWriteStream").and.callFake(() => stream);

          buffer.setText("Buffer contents\n".repeat(100));
          buffer.save().catch((error) => {
            expect(error.code).toBe("EACCES");
            expect(error.message).toBe("Permission denied");
            expect(buffer.getFileState()).toBe(FileState.MODIFIED);
            expect(buffer.outstandingSaveCount).toBe(0);
            done();
          });
        });
      });

    if (process.platform === "win32")
      describe("when a permission error occurs (Windows)", () => {
        it("can bypass hidden files", async (done) => {
          winattr.setSync(filePath, { hidden: true });

          buffer.setText("I just wrote to a hidden file in Windows!");
          await buffer.save();

          expect(fs.readFileSync(filePath, "utf8")).toBe(
            "I just wrote to a hidden file in Windows!",
          );
          expect(winattr.getSync(filePath).hidden).toBe(true);
          done();
        });
      });
  });

  describe(".saveAs", () => {
    let filePath;

    beforeEach(async (done) => {
      filePath = temp.openSync("lumine").path;
      fs.writeFileSync(filePath, "a");
      buffer = await TextBuffer.load(filePath);
      done();
    });

    it("saves the contents of the buffer to the new path", async (done) => {
      const didChangePathHandler = jasmine.createSpy("didChangePathHandler");
      buffer.onDidChangePath(didChangePathHandler);

      const newPath = temp.openSync("lumine").path;
      buffer.setText("b");
      await buffer.saveAs(newPath);
      expect(fs.readFileSync(newPath, "utf8")).toEqual("b");
      expect(didChangePathHandler).toHaveBeenCalledWith(newPath);
      done();
    });

    it("can save to a file in a non-existent directory", async (done) => {
      const directory = temp.mkdirSync("lumine");
      const newFilePath = path.join(directory, "a", "b", "c", "new-file");

      await buffer.saveAs(newFilePath);
      expect(fs.readFileSync(newFilePath, "utf8")).toBe(buffer.getText());
      expect(buffer.getPath()).toBe(newFilePath);
      done();
    });

    it("stops listening for changes to the old path and starts listening for changes to the new path", async (done) => {
      const didChangeHandler = jasmine.createSpy("didChangeHandler");
      buffer.onDidChange(didChangeHandler);

      const newPath = temp.openSync("lumine").path;
      await buffer.saveAs(newPath);
      await buffer.getFileWatchStartPromise();
      expect(didChangeHandler).not.toHaveBeenCalled();

      fs.writeFileSync(filePath, "does not trigger a buffer change");
      await timeoutPromise(100);
      expect(didChangeHandler).not.toHaveBeenCalled();
      expect(buffer.getText()).toBe("a");

      fs.writeFileSync(newPath, "does trigger a buffer change");
      await timeoutPromise(400);

      expect(didChangeHandler).toHaveBeenCalled();
      expect(buffer.getText()).toBe("does trigger a buffer change");
      done();
    });
  });

  describe(".getFileState", () => {
    let filePath;
    beforeEach(async (done) => {
      filePath = temp.openSync("lumine").path;
      fs.writeFileSync(filePath, "");
      buffer = await TextBuffer.load(filePath);
      // Arm the file watcher before each spec so on-disk deletions are observed
      // through the live watcher rather than raced against its asynchronous arm.
      await buffer.getFileWatchStartPromise();
      done();
    });

    describe("when the buffer is changed", () => {
      it("reports state changes exactly once", async (done) => {
        const fileStateChanges = [];
        buffer.onDidChangeFileState((fileState) => fileStateChanges.push(fileState));
        expect(buffer.getFileState()).toBe(FileState.UNMODIFIED);

        buffer.insert([0, 0], "hi");
        expect(buffer.getFileState()).toBe(FileState.MODIFIED);
        await stopChangingPromise();
        expect(fileStateChanges).toEqual([FileState.MODIFIED]);

        buffer.insert([0, 2], "ho");
        expect(buffer.getFileState()).toBe(FileState.MODIFIED);
        await stopChangingPromise();
        expect(fileStateChanges).toEqual([FileState.MODIFIED]);

        buffer.undo();
        buffer.undo();
        expect(buffer.getFileState()).toBe(FileState.UNMODIFIED);
        await stopChangingPromise();
        expect(fileStateChanges).toEqual([FileState.MODIFIED, FileState.UNMODIFIED]);
        done();
      });

      describe("and the file is deleted", () => {
        it("reports the modified status as true", async () => {
          buffer.setText(`lorem ipsum`);
          await buffer.save();
          buffer.setText(`lorem ipsum dolor`);
          fs.unlinkSync(filePath);
          await wait(500);
          expect(buffer.getFileState()).toBe(FileState.REMOVED);
        });
      });
    });

    describe("when the buffer is saved", () => {
      it("reports the state changing to unmodified", async (done) => {
        buffer.insert([0, 0], "hi");
        expect(buffer.getFileState()).toBe(FileState.MODIFIED);

        const fileStateChanges = [];
        buffer.onDidChangeFileState((fileState) => fileStateChanges.push(fileState));

        await buffer.save();
        expect(buffer.getFileState()).toBe(FileState.UNMODIFIED);
        await stopChangingPromise();
        expect(fileStateChanges).toEqual([FileState.UNMODIFIED]);
        done();
      });

      describe("and the file is deleted", () => {
        it("reports the removed state", async () => {
          buffer.setText(`lorem ipsum`);
          await buffer.save();
          await buffer.getFileWatchStartPromise();
          const deleted = deletionPromise(buffer);
          fs.unlinkSync(filePath);
          await deleted;
          expect(buffer.getFileState()).toBe(FileState.REMOVED);
        });

        it("keeps the removed state when the user makes further changes", async () => {
          buffer.setText(`lorem ipsum`);
          await buffer.save();
          await buffer.getFileWatchStartPromise();
          const deleted = deletionPromise(buffer);
          fs.unlinkSync(filePath);
          await deleted;
          expect(buffer.getFileState()).toBe(FileState.REMOVED);

          buffer.insert([0, 0], "! ");
          expect(buffer.getFileState()).toBe(FileState.REMOVED);

          // Removal is sticky even if we restore the text from deletion time.
          buffer.setText(`lorem ipsum`);
          expect(buffer.getFileState()).toBe(FileState.REMOVED);
        });

        describe("and re-saved", () => {
          it("returns the buffer to unmodified", async () => {
            buffer.setText(`lorem ipsum`);
            await buffer.save();
            await buffer.getFileWatchStartPromise();
            const deleted = deletionPromise(buffer);
            fs.unlinkSync(filePath);
            await deleted;
            buffer.insert([0, 0], "! ");
            expect(buffer.getFileState()).toBe(FileState.REMOVED);

            await buffer.saveAs(filePath);

            expect(buffer.getFileState()).toBe(FileState.UNMODIFIED);
          });
        });
      });
    });

    describe("when the buffer’s file is deleted", () => {
      it("reports removed regardless of whether it was modified at deletion", async () => {
        expect(buffer.getFileState()).toBe(FileState.UNMODIFIED);
        const deleted = deletionPromise(buffer);
        fs.unlinkSync(filePath);
        await deleted;
        expect(buffer.getFileState()).toBe(FileState.REMOVED);

        await buffer.save();
        expect(buffer.getFileState()).toBe(FileState.UNMODIFIED);

        buffer.insert([0, 0], "hi");
        expect(buffer.getFileState()).toBe(FileState.MODIFIED);
        // Let the watcher observe the file existing again before deleting it a
        // second time. Re-creating and re-deleting the same path within a single
        // watcher batch coalesces into no net change, so this transition has no
        // event to await — the operations must be spaced in wall-clock time.
        await wait(500);
        const deletedAgain = deletionPromise(buffer);
        fs.unlinkSync(filePath);
        await deletedAgain;
        expect(buffer.getFileState()).toBe(FileState.REMOVED);
      });
    });

    describe("when the buffer is re-saved after deletion", () => {
      it("stops reporting the file as deleted or modified", async (done) => {
        buffer.insert([0, 0], "hi");
        expect(buffer.getFileState()).toBe(FileState.MODIFIED);

        const deleted = deletionPromise(buffer);
        fs.unlinkSync(filePath);
        await deleted;
        expect(buffer.getFileState()).toBe(FileState.REMOVED);

        await buffer.save();
        expect(buffer.getFileState()).toBe(FileState.UNMODIFIED);

        buffer.insert([0, 0], "hi");
        // Let the watcher observe the file existing again before deleting it a
        // second time. Re-creating and re-deleting the same path within a single
        // watcher batch coalesces into no net change, so this transition has no
        // event to await — the operations must be spaced in wall-clock time.
        await wait(500);
        const deletedAgain = deletionPromise(buffer);
        fs.unlinkSync(filePath);
        await deletedAgain;
        expect(buffer.getFileState()).toBe(FileState.REMOVED);
        done();
      });
    });

    describe("when the buffer is reloaded", () => {
      it("reports the state changing to unmodified", async () => {
        const fileStateChanges = [];
        buffer.onDidChangeFileState((fileState) => fileStateChanges.push(fileState));

        buffer.insert([0, 0], "hi");
        expect(buffer.getFileState()).toBe(FileState.MODIFIED);
        expect(fileStateChanges).toEqual([FileState.MODIFIED]);

        await buffer.reload();
        expect(buffer.getFileState()).toBe(FileState.UNMODIFIED);
        expect(fileStateChanges).toEqual([FileState.MODIFIED, FileState.UNMODIFIED]);
      });
    });

    it("returns false for an empty buffer with no path", () => {
      buffer2 = new TextBuffer();
      expect(buffer2.getFileState()).toBe(FileState.UNMODIFIED);
      buffer2.append("hello");
      expect(buffer2.getFileState()).toBe(FileState.MODIFIED);
    });

    it("returns unmodified for an empty buffer at a path that never existed", async (done) => {
      const filePath = path.join(temp.mkdirSync(), "file-to-delete");
      buffer = await TextBuffer.load(filePath);
      expect(buffer.getFileState()).toBe(FileState.UNMODIFIED);
      done();
    });

    it("returns true for a non-empty buffer with no path", () => {
      buffer2 = new TextBuffer({ text: "something" });
      expect(buffer2.getFileState()).toBe(FileState.MODIFIED);

      buffer2.append("a");
      expect(buffer2.getFileState()).toBe(FileState.MODIFIED);

      buffer2.setText("");
      expect(buffer2.getFileState()).toBe(FileState.UNMODIFIED);
    });
  });

  describe(".serialize and .deserialize", () => {
    describe("when the disk contents have not changed since serialization", () => {
      it("restores the previous unsaved state of the buffer, along with its markers and history", async (done) => {
        const filePath = temp.openSync("lumine").path;
        fs.writeFileSync(filePath, "abc\ndef\n");

        buffer = await TextBuffer.load(filePath);
        buffer.append("ghi\n");
        const markerLayer = buffer.addMarkerLayer({ persistent: true });
        const marker = markerLayer.markRange(Range(Point(1, 2), Point(2, 1)));

        buffer2 = await TextBuffer.deserialize(buffer.serialize());
        const markerLayer2 = buffer2.getMarkerLayer(markerLayer.id);
        const marker2 = markerLayer2.getMarker(marker.id);
        expect(buffer2.getText()).toBe("abc\ndef\nghi\n");
        expect(marker2.getRange()).toEqual(Range(Point(1, 2), Point(2, 1)));
        expect(buffer2.undo()).toBe(true);
        expect(buffer2.getText()).toBe("abc\ndef\n");

        expect(buffer2.markPosition(Point(0, 0)).id).toBe(buffer.markPosition(Point(0, 0)).id);
        expect(buffer2.addMarkerLayer().id).toBe(buffer.addMarkerLayer().id);
        done();
      });
    });

    describe("when the disk contents have changed since serialization", () => {
      it("preserves the unsaved text and marks it conflicted", async (done) => {
        const filePath = temp.openSync("lumine").path;
        fs.writeFileSync(filePath, "abc\ndef\n");

        buffer = await TextBuffer.load(filePath);
        buffer.append("ghi\n");
        fs.writeFileSync(filePath, "DISK CHANGE");
        buffer2 = await TextBuffer.deserialize(buffer.serialize());
        expect(buffer2.getPath()).toBe(buffer.getPath());
        expect(buffer2.getText()).toBe("abc\ndef\nghi\n");
        expect(buffer2.getFileState()).toBe(FileState.CONFLICTED);
        expect(buffer2.undo()).toBe(false);
        expect(buffer2.getText()).toBe("abc\ndef\nghi\n");
        done();
      });
    });

    it("restores the exact text and removed state when the backing file is missing", async () => {
      const filePath = temp.openSync("lumine").path;
      fs.writeFileSync(filePath, "alpha\nbeta\ngamma\n");
      buffer = await TextBuffer.load(filePath);
      await buffer.getFileWatchStartPromise();
      buffer.setTextInRange(
        [
          [1, 0],
          [1, 4],
        ],
        "LOCAL-BETA",
      );
      buffer.insert([0, 0], "prefix: ");
      const expectedText = buffer.getText();

      const removed = deletionPromise(buffer);
      fs.removeSync(filePath);
      await removed;
      const state = buffer.serialize();

      buffer2 = await TextBuffer.deserialize(state);
      expect(buffer2.getText()).toBe(expectedText);
      expect(buffer2.getFileState()).toBe(FileState.REMOVED);
      expect(buffer2.undo()).toBe(false);
    });

    it("restores a never-saved path as modified rather than removed", async () => {
      const filePath = path.join(temp.mkdirSync(), "draft.txt");
      buffer = await TextBuffer.load(filePath);
      buffer.append("draft text");

      buffer2 = await TextBuffer.deserialize(buffer.serialize());

      expect(buffer2.getPath()).toBe(filePath);
      expect(buffer2.getText()).toBe("draft text");
      expect(buffer2.getFileState()).toBe(FileState.MODIFIED);
      expect(buffer2.undo()).toBe(true);
      expect(buffer2.getText()).toBe("");
    });

    it("serializes the encoding", async (done) => {
      const filePath = path.join(__dirname, "fixtures", "win1251.txt");
      buffer = await TextBuffer.load(filePath, { encoding: "WINDOWS-1251" });
      buffer2 = await TextBuffer.deserialize(buffer.serialize());
      expect(buffer2.getEncoding()).toBe("WINDOWS-1251");
      expect(buffer2.getText()).toBe("тест 1234 абвгдеёжз");
      done();
    });
  });

  describe("encoding support", () => {
    it("allows the encoding to be set on creation", async (done) => {
      const filePath = path.join(__dirname, "fixtures", "win1251.txt");
      buffer = await TextBuffer.load(filePath, { encoding: "WINDOWS-1251" });
      expect(buffer.getEncoding()).toBe("WINDOWS-1251");
      expect(buffer.getText()).toBe("тест 1234 абвгдеёжз");
      done();
    });

    describe("when the buffer is modified", () => {
      describe("when the encoding of the buffer is changed", () => {
        beforeEach(async () => {
          const filePath = path.join(__dirname, "fixtures", "win1251.txt");
          buffer = await TextBuffer.load(filePath);
        });

        it("does not reload the contents from the disk", (done) => {
          buffer.setText("ch ch changes");
          buffer.setEncoding("win1251");
          setTimeout(() => {
            expect(buffer.getText()).toBe("ch ch changes");
            done();
          }, 250);
        });
      });
    });

    describe("when the buffer is unmodified", () => {
      describe("when the encoding of the buffer is changed", () => {
        beforeEach(async (done) => {
          const filePath = path.join(__dirname, "fixtures", "win1251.txt");
          buffer = await TextBuffer.load(filePath);
          done();
        });

        beforeEach(async () => {
          expect(buffer.getEncoding()).toBe("utf8");
          expect(buffer.getText()).not.toBe("тест 1234 абвгдеёжз");

          const changed = new Promise((resolve) => buffer.onDidChange(resolve));
          buffer.setEncoding("WINDOWS-1251");
          expect(buffer.getEncoding()).toBe("WINDOWS-1251");
          await changed;
        });

        it("reloads the contents from the disk", () => {
          expect(buffer.getText()).toBe("тест 1234 абвгдеёжз");
        });
      });
    });

    it("emits an event when the encoding changes", async (done) => {
      const filePath = path.join(__dirname, "fixtures", "win1251.txt");
      const encodingChanges = [];

      buffer = await TextBuffer.load(filePath);
      buffer.onDidChangeEncoding((encoding) => encodingChanges.push(encoding));
      buffer.setEncoding("WINDOWS-1251");
      expect(encodingChanges).toEqual(["WINDOWS-1251"]);

      buffer.setEncoding("WINDOWS-1251");
      expect(encodingChanges).toEqual(["WINDOWS-1251"]);

      buffer2 = new TextBuffer();
      buffer2.onDidChangeEncoding((encoding) => encodingChanges.push(encoding));
      buffer2.setEncoding("WINDOWS-1251");
      expect(encodingChanges).toEqual(["WINDOWS-1251", "WINDOWS-1251"]);

      buffer2.setEncoding("WINDOWS-1251");
      expect(encodingChanges).toEqual(["WINDOWS-1251", "WINDOWS-1251"]);
      done();
    });

    describe("when a buffer's encoding is changed", () => {
      beforeEach(async () => {
        const filePath = path.join(__dirname, "fixtures", "win1251.txt");
        buffer = await TextBuffer.load(filePath);
        const changed = new Promise((resolve) => buffer.onDidChange(resolve));
        buffer.setEncoding("WINDOWS-1251");
        await changed;
      });

      it("does not push the encoding change onto the undo stack", () => {
        buffer.undo();
        expect(buffer.getText()).toBe("тест 1234 абвгдеёжз");
      });
    });
  });

  describe("when the file changes on disk", () => {
    let filePath;

    beforeEach(async (done) => {
      filePath = temp.openSync("lumine").path;
      fs.writeFileSync(filePath, "abcde");
      buffer = await TextBuffer.load(filePath);
      // The watcher arms asynchronously; wait for it so external writes below
      // are reliably observed.
      await buffer.getFileWatchStartPromise();
      done();
    });

    it("enters conflicted if the buffer is modified", async (done) => {
      buffer.append("f");
      expect(buffer.getText()).toBe("abcdef");
      expect(buffer.getFileState()).toBe(FileState.MODIFIED);

      fs.writeFileSync(buffer.getPath(), "  abc");

      const subscription = buffer.onDidChangeFileState((fileState) => {
        if (fileState === FileState.CONFLICTED) {
          subscription.dispose();
          expect(buffer.getText()).toBe("abcdef");
          expect(buffer.getFileState()).toBe(FileState.CONFLICTED);
          done();
        }
      });
    });

    it("enters conflicted if the buffer is modified and backed by a custom file", async (done) => {
      fs.writeFileSync(buffer.getPath(), "abcde");
      const file = new ReverseCaseFile(filePath);
      buffer.setFile(file);

      // `ReverseCaseFile` uses `fs.watch` to set up file-watching. This
      // built-in method is fast, but not instantaneous.
      await wait(process.env.CI ? 500 : 200);

      buffer.append("f");
      expect(buffer.getText()).toBe("abcdef");
      expect(buffer.getFileState()).toBe(FileState.MODIFIED);

      const subscription = buffer.onDidChangeFileState((fileState) => {
        if (fileState === FileState.CONFLICTED) {
          subscription.dispose();
          expect(buffer.getText()).toBe("abcdef");
          expect(buffer.getFileState()).toBe(FileState.CONFLICTED);
          done();
        }
      });

      fs.writeFileSync(buffer.getPath(), "  abc");
    });

    it("updates the buffer and its markers and notifies change observers if the buffer is unmodified", async (done) => {
      expect(buffer.getText()).toEqual("abcde");

      const newTextSuffix = "!".repeat(1024);
      const newText = " abc" + newTextSuffix;

      const events = [];
      buffer.onWillReload((_event) => events.push(["will-reload"]));
      buffer.onWillChange(() => {
        expect(buffer.getText()).toEqual("abcde");
        events.push(["will-change"]);
      });
      buffer.onDidChange((event) => events.push(["did-change", event]));
      buffer.onDidReload((_event) => events.push(["did-reload"]));

      const markerB = buffer.markRange(Range(Point(0, 1), Point(0, 2)));
      const markerD = buffer.markRange(Range(Point(0, 3), Point(0, 4)));

      fs.writeFileSync(buffer.getPath(), newText);

      const subscription = buffer.onDidReload(() => {
        subscription.dispose();

        expect(buffer.getFileState()).toBe(FileState.UNMODIFIED);
        expect(buffer.getText()).toBe(newText);

        expect(markerB.getRange()).toEqual(Range(Point(0, 2), Point(0, 3)));
        expect(markerD.getRange()).toEqual(Range(Point(0, 4), Point(0, newText.length)));
        expect(markerB.isValid()).toBe(true);
        expect(markerD.isValid()).toBe(false);

        expect(toPlainObject(events)).toEqual(
          toPlainObject([
            ["will-reload"],
            ["will-change"],
            [
              "did-change",
              {
                oldRange: Range(Point(0, 0), Point(0, 5)),
                newRange: Range(Point(0, 0), Point(0, newText.length)),
                changes: [
                  {
                    oldRange: Range(Point.ZERO, Point.ZERO),
                    newRange: Range(Point.ZERO, Point(0, 1)),
                    oldText: "",
                    newText: " ",
                  },
                  {
                    oldRange: Range(Point(0, 3), Point(0, 5)),
                    newRange: Range(Point(0, 4), Point(0, newText.length)),
                    oldText: "de",
                    newText: newTextSuffix,
                  },
                ],
              },
            ],
            ["did-reload"],
          ]),
        );

        done();
      });
    });

    it("passes the smallest possible change event to onDidChange listeners", async (done) => {
      fs.writeFileSync(buffer.getPath(), "abc de ");

      const events = [];
      buffer.onWillChange(() => events.push(["will-change"]));
      buffer.onDidChange((event) => events.push(["did-change", event]));

      const subscription = buffer.onDidReload(() => {
        subscription.dispose();

        expect(buffer.getText()).toBe("abc de ");

        expect(toPlainObject(events)).toEqual(
          toPlainObject([
            ["will-change"],
            [
              "did-change",
              {
                oldRange: Range(Point(0, 3), Point(0, 5)),
                newRange: Range(Point(0, 3), Point(0, 7)),
                changes: [
                  {
                    oldRange: Range(Point(0, 3), Point(0, 3)),
                    newRange: Range(Point(0, 3), Point(0, 4)),
                    oldText: "",
                    newText: " ",
                  },
                  {
                    oldRange: Range(Point(0, 5), Point(0, 5)),
                    newRange: Range(Point(0, 6), Point(0, 7)),
                    oldText: "",
                    newText: " ",
                  },
                ],
              },
            ],
          ]),
        );

        done();
      });
    });

    it("does nothing when the file is rewritten with the same contents", async () => {
      const events = [];
      buffer.onWillReload((event) => events.push(event));
      buffer.onDidReload((event) => events.push(event));
      buffer.onDidChange((event) => events.push(event));
      buffer.onDidChangeFileState((fileState) => events.push(fileState));

      fs.writeFileSync(buffer.getPath(), "abcde");

      // Wait for the watcher (or the arm-time reconcile) to process the write.
      await wait(buffer.fileChangeDelay + 250);
      expect(buffer.getText()).toBe("abcde");
      expect(events.length).toBe(0);
    });

    it("reports a conflict when the buffer is edited during an automatic reload", async () => {
      const controlledFile = new ControlledFile(filePath);
      buffer.setFile(controlledFile);

      const controlledLoad = pauseNextNativeLoad(buffer);
      const loadSpy = spyOn(buffer, "load").and.callThrough();
      const events = [];
      buffer.onDidChangeFileState((fileState) => {
        if (fileState === FileState.CONFLICTED) events.push("conflicted");
      });
      buffer.onDidReload(() => events.push("did-reload"));

      fs.writeFileSync(filePath, "changed on disk");
      controlledFile.emitDidChange();
      await controlledLoad.started;

      const automaticLoad = loadSpy.calls.mostRecent().returnValue;
      buffer.append("f");
      controlledLoad.release();
      await automaticLoad;

      expect(events).toEqual(["conflicted"]);
      expect(buffer.getText()).toBe("abcdef");
      expect(buffer.getFileState()).toBe(FileState.CONFLICTED);

      expect(buffer.undo()).toBe(true);
      expect(buffer.getText()).toBe("abcde");
      expect(buffer.getFileState()).toBe(FileState.CONFLICTED);
      expect(buffer.undo()).toBe(false);
    });

    it("does not report a conflict when the disk still matches the base after a cancelled reload", async () => {
      const controlledFile = new ControlledFile(filePath);
      buffer.setFile(controlledFile);

      const controlledLoad = pauseNextNativeLoad(buffer);
      const loadSpy = spyOn(buffer, "load").and.callThrough();
      const events = [];
      buffer.onDidChangeFileState((fileState) => {
        if (fileState === FileState.CONFLICTED) events.push("conflicted");
      });
      buffer.onDidReload(() => events.push("did-reload"));

      fs.writeFileSync(filePath, "abcde");
      controlledFile.emitDidChange();
      await controlledLoad.started;

      const automaticLoad = loadSpy.calls.mostRecent().returnValue;
      buffer.append("f");
      controlledLoad.release();
      await automaticLoad;

      expect(events).toEqual([]);
      expect(buffer.getText()).toBe("abcdef");
      expect(buffer.getFileState()).toBe(FileState.MODIFIED);
    });

    it("does not fire duplicate change events when multiple changes happen on disk", async () => {
      // Drive the file notifications explicitly. The path-watcher integration
      // is covered separately; this spec needs to control exactly when each
      // debounced load begins so it can exercise overlapping loads without
      // depending on an OS watcher delivering three distinct write bursts.
      const controlledFile = new ControlledFile(filePath);
      buffer.setFile(controlledFile);

      const changeEvents = [];
      buffer.onWillChange(() => changeEvents.push("will-change"));
      buffer.onDidChange((_event) => changeEvents.push("did-change"));

      // We debounce file system change events to avoid redundant loads. But
      // for large files, another file system change event may occur *after* the
      // debounce interval but *before* the previous load has completed. In
      // that scenario, we still want to avoid emitting redundant change events.
      //
      // This test simulates the buffer taking a long time to load and diff by
      // first reading the file's current contents (copying them to a temp file),
      // then waiting for a period of time longer than the debounce interval,
      // and then performing the actual load.
      const originalLoad = buffer.buffer.load;
      const pendingLoads = [];
      let resolveLoadStarted;
      spyOn(NativeTextBuffer.prototype, "load").and.callFake(function (pathToLoad, ...args) {
        const pathToLoadCopy = temp.openSync("lumine").path;
        fs.writeFileSync(pathToLoadCopy, fs.readFileSync(pathToLoad));
        const loadStarted = resolveLoadStarted;
        resolveLoadStarted = null;

        let release;
        const promise = new Promise((resolve) => {
          release = () => resolve(originalLoad.call(this, pathToLoadCopy, ...args));
        });
        pendingLoads.push({ promise, release });
        loadStarted();
        return promise;
      });

      const writeBurstAndWaitForLoad = async (intermediateText, finalText) => {
        const loadStarted = new Promise((resolve) => {
          resolveLoadStarted = resolve;
        });
        fs.writeFileSync(filePath, intermediateText);
        controlledFile.emitDidChange();
        fs.writeFileSync(filePath, finalText);
        controlledFile.emitDidChange();
        await loadStarted;
      };

      await writeBurstAndWaitForLoad("a", "ab");
      await writeBurstAndWaitForLoad("abc", "abcd");
      await writeBurstAndWaitForLoad("abcde", "abcdef");

      const changed = new Promise((resolve) => buffer.onDidChange(resolve));
      // All three TextBuffer loads are already overlapping at this point.
      // Complete their native reads oldest-to-newest so the latest snapshot is
      // deterministically the final one applied to the native buffer.
      for (const { promise, release } of pendingLoads) {
        release();
        await promise;
      }
      await changed;

      expect(buffer.getText()).toBe("abcdef");
      expect(changeEvents).toEqual(["will-change", "did-change"]);
    });
  });

  describe("when the file is deleted", () => {
    let filePath;

    beforeEach(async (done) => {
      filePath = path.join(temp.mkdirSync(), "file-to-delete");
      fs.writeFileSync(filePath, "delete me");
      buffer = await TextBuffer.load(filePath);
      filePath = buffer.getPath(); // symlinks may have been converted
      await buffer.getFileWatchStartPromise();
      done();
    });

    for (const initiallyModified of [false, true]) {
      it(`retains its path and enters removed when initially ${
        initiallyModified ? "modified" : "unmodified"
      }`, async () => {
        if (initiallyModified) buffer.setText("I WAS MODIFIED");
        const removed = fileStatePromise(buffer, FileState.REMOVED);
        fs.removeSync(filePath);
        await removed;

        expect(buffer.getPath()).toBe(filePath);
        expect(buffer.getFileState()).toBe(FileState.REMOVED);
        expect(buffer.isDestroyed()).toBe(false);
      });
    }

    it("emits one state event for deletion", async () => {
      const states = [];
      buffer.onDidChangeFileState((fileState) => states.push(fileState));
      const removed = fileStatePromise(buffer, FileState.REMOVED);
      fs.removeSync(filePath);
      await removed;
      expect(states).toEqual([FileState.REMOVED]);
    });

    it("resumes watching of the file when it is re-saved", async (done) => {
      const removed = fileStatePromise(buffer, FileState.REMOVED);
      fs.removeSync(filePath);
      await removed;
      await buffer.save();
      expect(fs.existsSync(buffer.getPath())).toBeTruthy();
      expect(buffer.getFileState()).toBe(FileState.UNMODIFIED);

      buffer.onDidChange(() => {
        expect(buffer.getText()).toBe("moo");
        done();
      });
      await buffer.getFileWatchStartPromise();
      await wait(process.env.CI ? 200 : 20);
      fs.writeFileSync(filePath, "moo");
    });
  });
});

class ReverseCaseFile {
  constructor(path) {
    this.path = path;
  }

  existsSync() {
    return fs.existsSync(this.path);
  }

  getPath() {
    return this.path;
  }

  createReadStream() {
    return fs.createReadStream(this.path).pipe(
      new Transform({
        transform(chunk, encoding, callback) {
          callback(null, reverseCase(chunk));
        },
      }),
    );
  }

  createWriteStream() {
    const stream = fs.createWriteStream(this.path);
    return new Writable({
      write(chunk, encoding, callback) {
        stream.write(reverseCase(chunk), encoding, callback);
      },
    });
  }

  onDidChange(callback) {
    const watcher = fs.watch(this.path, callback);
    return new Disposable(() => watcher.close());
  }
}

class ControlledFile extends TextBufferFile {
  onDidChange(callback) {
    this.didChangeCallback = callback;
    return new Disposable(() => {
      if (this.didChangeCallback === callback) this.didChangeCallback = null;
    });
  }

  emitDidChange() {
    this.didChangeCallback();
  }
}

function pauseNextNativeLoad(buffer) {
  const originalLoad = buffer.buffer.load;
  let releaseLoad;
  let resolveLoadStarted;
  const started = new Promise((resolve) => {
    resolveLoadStarted = resolve;
  });

  spyOn(NativeTextBuffer.prototype, "load").and.callFake(function (pathToLoad, ...args) {
    const pathToLoadCopy = temp.openSync("lumine").path;
    fs.writeFileSync(pathToLoadCopy, fs.readFileSync(pathToLoad));

    const promise = new Promise((resolve) => {
      releaseLoad = () => resolve(originalLoad.call(this, pathToLoadCopy, ...args));
    });
    resolveLoadStarted();
    return promise;
  });

  return {
    started,
    release() {
      releaseLoad();
    },
  };
}

function reverseCase(buffer, _encoding) {
  const result = Buffer.alloc(buffer.length);
  for (let i = 0, n = buffer.length; i < n; i++) {
    const character = String.fromCharCode(buffer[i]);
    result[i] = (
      character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase()
    ).charCodeAt(0);
  }
  return result;
}

function stopChangingPromise() {
  return timeoutPromise(TextBuffer.prototype.stoppedChangingDelay * 2);
}

function timeoutPromise(duration) {
  return new Promise((resolve) => setTimeout(resolve, duration));
}

function deletionPromise(buffer) {
  return fileStatePromise(buffer, FileState.REMOVED);
}

function fileStatePromise(buffer, expectedState) {
  return new Promise((resolve) => {
    const subscription = buffer.onDidChangeFileState((fileState) => {
      if (fileState === expectedState) {
        subscription.dispose();
        resolve();
      }
    });
  });
}

function toPlainObject(value) {
  return JSON.parse(JSON.stringify(value));
}
