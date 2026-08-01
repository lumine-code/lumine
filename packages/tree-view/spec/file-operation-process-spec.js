const fs = require("fs");
const os = require("os");
const path = require("path");
const FileOperationProcess = require("../lib/file-operation-process");

describe("TreeView file operation process", () => {
  let rootPath;
  let operations;

  beforeEach(() => {
    rootPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tree-view-operation-")));
  });

  afterEach(() => {
    operations?.destroy();
    fs.rmSync(rootPath, { recursive: true, force: true });
  });

  it("copies and moves queued files outside the renderer", async () => {
    const sourcePath = path.join(rootPath, "source.bin");
    const copyPath = path.join(rootPath, "copy.bin");
    const movedPath = path.join(rootPath, "moved.bin");
    const contents = Buffer.alloc(1024 * 1024, 7);
    fs.writeFileSync(sourcePath, contents);

    const phases = [];
    operations = new FileOperationProcess({
      onDidProgress: ({ phase }) => phases.push(phase),
    });
    const copyPromise = operations.run("copy", sourcePath, copyPath);
    const movePromise = operations.run("move", copyPath, movedPath);

    expect(operations.getOperations().map(({ state }) => state)).toEqual(["running", "queued"]);

    expect(await copyPromise).toEqual({ copied: true });
    expect(await movePromise).toEqual({ moved: true });
    expect(fs.existsSync(copyPath)).toBe(false);
    expect(fs.readFileSync(movedPath)).toEqual(contents);
    expect(phases).toContain("copying");
    expect(phases).toContain("moving");
  });

  it("cancels an active copy and removes its partial destination", async () => {
    const sourcePath = path.join(rootPath, "source.bin");
    const copyPath = path.join(rootPath, "copy.bin");
    fs.writeFileSync(sourcePath, Buffer.alloc(1024 * 1024, 7));
    operations = new FileOperationProcess();

    const copyPromise = operations.run("copy", sourcePath, copyPath);
    expect(operations.cancel(copyPromise.operationId)).toBe(true);

    expect(await copyPromise).toEqual({ cancelled: true });
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(copyPath)).toBe(false);
  });

  it("removes a queued operation without starting it", async () => {
    const sourcePath = path.join(rootPath, "source.bin");
    const firstCopyPath = path.join(rootPath, "first.bin");
    const queuedCopyPath = path.join(rootPath, "queued.bin");
    fs.writeFileSync(sourcePath, Buffer.alloc(1024 * 1024, 7));
    operations = new FileOperationProcess();

    const firstCopy = operations.run("copy", sourcePath, firstCopyPath);
    const queuedCopy = operations.run("copy", sourcePath, queuedCopyPath);
    expect(operations.cancel(queuedCopy.operationId)).toBe(true);

    expect(await queuedCopy).toEqual({ cancelled: true });
    expect(await firstCopy).toEqual({ copied: true });
    expect(fs.existsSync(queuedCopyPath)).toBe(false);
  });

  it("asks the renderer before replacing a conflicting file", async () => {
    const sourceDirectory = path.join(rootPath, "source");
    const destinationDirectory = path.join(rootPath, "destination");
    fs.mkdirSync(sourceDirectory);
    fs.mkdirSync(destinationDirectory);
    fs.writeFileSync(path.join(sourceDirectory, "file.txt"), "new");
    fs.writeFileSync(path.join(destinationDirectory, "file.txt"), "old");

    const conflicts = [];
    operations = new FileOperationProcess({
      onConflict(conflict) {
        conflicts.push(conflict);
        return "replace";
      },
    });

    expect(await operations.run("move", sourceDirectory, destinationDirectory)).toEqual({
      moved: true,
    });
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].relativePath).toBe(path.join("destination", "file.txt"));
    expect(fs.readFileSync(path.join(destinationDirectory, "file.txt"), "utf8")).toBe("new");
    expect(fs.existsSync(sourceDirectory)).toBe(false);
  });

  it("reports a partial directory move when a conflict is skipped", async () => {
    const sourceDirectory = path.join(rootPath, "source");
    const destinationDirectory = path.join(rootPath, "destination");
    fs.mkdirSync(sourceDirectory);
    fs.mkdirSync(destinationDirectory);
    fs.writeFileSync(path.join(sourceDirectory, "conflict.txt"), "new");
    fs.writeFileSync(path.join(sourceDirectory, "fresh.txt"), "fresh");
    fs.writeFileSync(path.join(destinationDirectory, "conflict.txt"), "old");

    operations = new FileOperationProcess({ onConflict: () => "skip" });

    expect(await operations.run("move", sourceDirectory, destinationDirectory)).toEqual({
      skipped: true,
      partial: true,
    });
    expect(fs.readFileSync(path.join(sourceDirectory, "conflict.txt"), "utf8")).toBe("new");
    expect(fs.readFileSync(path.join(destinationDirectory, "conflict.txt"), "utf8")).toBe("old");
    expect(fs.readFileSync(path.join(destinationDirectory, "fresh.txt"), "utf8")).toBe("fresh");
  });
});
