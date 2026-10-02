const fs = require("fs");
const os = require("os");
const path = require("path");
const FileWatchWorker = require("../src/file-watch-worker");

describe("File watch planning cost", () => {
  let fixture;
  let worker;

  beforeEach(() => {
    fixture = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "lumine-watch-planning-")),
    );
    worker = new FileWatchWorker({ engine: { close: async () => {} }, sendEvent() {} });
  });

  afterEach(async () => {
    await worker.close();
    expect(path.dirname(fixture)).toBe(fs.realpathSync.native(os.tmpdir()));
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  it("reads a shared guard/main directory once per plan and revalidates its replacement", async () => {
    const directory = path.join(fixture, "parent");
    const target = path.join(directory, "file");
    fs.mkdirSync(directory);
    fs.writeFileSync(target, "before");
    let stats = 0;
    let realpaths = 0;
    worker.fs = {
      ...fs.promises,
      stat(filePath, options) {
        if (filePath === directory) stats++;
        return fs.promises.stat(filePath, options);
      },
      realpath(filePath) {
        if (filePath === directory) realpaths++;
        return fs.promises.realpath(filePath);
      },
    };
    const logical = { path: target, kind: "file", recursive: false };
    const key = `${directory}\0${0}\0${0}`;
    const first = await worker.plan(logical);
    expect(stats).toBe(1);
    expect(realpaths).toBe(1);
    expect(first.descriptors.get(key).main).toBe(true);
    if (process.platform !== "darwin") {
      expect(first.descriptors.get(key).guardPaths.has(target)).toBe(true);
    }

    // Keeping the old directory prevents inode reuse from obscuring whether
    // verification read the new physical generation at the same pathname.
    fs.renameSync(directory, path.join(fixture, "previous-parent"));
    fs.mkdirSync(directory);
    fs.writeFileSync(target, "after");
    const verified = await worker.plan(logical);
    expect(stats).toBe(2);
    expect(realpaths).toBe(2);
    expect(verified.descriptors.get(key).identity).not.toBe(first.descriptors.get(key).identity);
    expect(verified.signature).not.toBe(first.signature);
  });

  it("reuses the pending-read adapter while honoring a replacement filesystem", async () => {
    const adapter = worker.planningFilesystem();
    expect(worker.planningFilesystem()).toBe(adapter);
    const calls = [];
    worker.fs = {
      ...fs.promises,
      realpath(filePath) {
        calls.push(filePath);
        return fs.promises.realpath(filePath);
      },
    };
    expect(await adapter.realpath(fixture)).toBe(fixture);
    expect(calls).toEqual([fixture]);
    expect(worker.planningReads.size).toBe(0);
  });
});
