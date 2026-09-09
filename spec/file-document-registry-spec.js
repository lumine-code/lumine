const path = require("path");
const fs = require("fs");
const os = require("os");
const FileDocumentRegistry = require("../src/file-document-registry");

describe("FileDocumentRegistry", () => {
  let registry;
  const absolute = (name) => path.resolve(name);
  beforeEach(() => {
    registry = new FileDocumentRegistry();
  });
  afterEach(() => registry.dispose());

  function document(filePath) {
    const owner = { path: absolute(filePath), dirty: true, undo: ["unsaved edit"], suspended: 0 };
    owner.registration = registry.register({
      owner,
      getPath: () => owner.path,
      setPath: (target) => {
        owner.path = target;
      },
      beginFileOperation: () => {
        owner.suspended++;
      },
      endFileOperation: () => {
        owner.suspended--;
      },
    });
    return owner;
  }
  const move = (from, to, isDirectory = false) => ({
    oldPath: absolute(from),
    newPath: absolute(to),
    isDirectory,
  });

  it("retargets a shared dirty document once and preserves its identity and undo", async () => {
    const doc = document("a.txt");
    const registration = registry.register({
      owner: doc,
      getPath: () => doc.path,
      setPath: () => {
        throw new Error("duplicate adapter");
      },
    });
    const effect = move("a.txt", "b.txt");
    const operation = registry.beginFileMove([effect]);
    expect(doc.suspended).toBe(1);
    await operation.complete([effect]);
    expect(doc.path).toBe(absolute("b.txt"));
    expect(doc.dirty).toBe(true);
    expect(doc.undo).toEqual(["unsaved edit"]);
    expect(doc.suspended).toBe(0);
    registration.dispose();
  });

  it("moves directory descendants without matching sibling prefixes", async () => {
    const child = document("dir/a.txt");
    const sibling = document("dir-other/a.txt");
    const effect = move("dir", "new-dir", true);
    const operation = registry.beginFileMove([effect]);
    expect(sibling.suspended).toBe(0);
    await operation.complete([effect]);
    expect(child.path).toBe(absolute("new-dir/a.txt"));
    expect(sibling.path).toBe(absolute("dir-other/a.txt"));
  });

  it("applies only confirmed effects from a partial operation", async () => {
    const first = document("a.txt");
    const second = document("b.txt");
    const effects = [move("a.txt", "x.txt"), move("b.txt", "y.txt")];
    const operation = registry.beginFileMove(effects);
    await operation.complete([effects[0]]);
    expect(first.path).toBe(absolute("x.txt"));
    expect(second.path).toBe(absolute("b.txt"));
    expect(second.suspended).toBe(0);
  });

  it("releases guards after rollback and makes completion idempotent", async () => {
    const doc = document("a.txt");
    const effect = move("a.txt", "b.txt");
    const operation = registry.beginFileMove([effect]);
    await operation.complete([]);
    await operation.complete([effect]);
    expect(doc.path).toBe(absolute("a.txt"));
    expect(doc.suspended).toBe(0);
  });

  it("rejects a destination already owned by another open document before suspension", () => {
    const source = document("a.txt");
    document("b.txt");
    expect(() => registry.beginFileMove([move("a.txt", "b.txt")])).toThrow();
    expect(source.suspended).toBe(0);
  });

  it("preserves the execution order of chained moves", async () => {
    const doc = document("a.txt");
    const effects = [move("a.txt", "b.txt"), move("b.txt", "c.txt")];
    await registry.beginFileMove(effects).complete(effects);
    expect(doc.path).toBe(absolute("c.txt"));
  });

  it("rejects a chain that would merge two open documents into one destination", () => {
    const first = document("a.txt");
    const second = document("b.txt");
    const effects = [move("a.txt", "b.txt"), move("b.txt", "c.txt")];
    expect(() => registry.beginFileMove(effects)).toThrow();
    expect(first.suspended).toBe(0);
    expect(second.suspended).toBe(0);
  });

  it("allows a chain that vacates an open destination before moving another document there", async () => {
    const first = document("a.txt");
    const second = document("b.txt");
    const effects = [move("b.txt", "c.txt"), move("a.txt", "b.txt")];
    await registry.beginFileMove(effects).complete(effects);
    expect(first.path).toBe(absolute("b.txt"));
    expect(second.path).toBe(absolute("c.txt"));
  });

  it("rejects separate source moves to the same final destination", () => {
    document("a.txt");
    document("b.txt");
    expect(() =>
      registry.beginFileMove([move("a.txt", "c.txt"), move("b.txt", "c.txt")]),
    ).toThrow();
  });

  it("recognizes an open missing destination through an existing symlink parent", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "move-alias-regression-"));
    try {
      const real = path.join(directory, "real");
      const alias = path.join(directory, "alias");
      fs.mkdirSync(real);
      fs.symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
      const oldPath = path.join(directory, "source");
      fs.writeFileSync(oldPath, "original");
      const source = document(oldPath);
      document(path.join(real, "missing", "file.txt"));
      expect(() =>
        registry.beginFileMove([move(oldPath, path.join(alias, "missing", "file.txt"))]),
      ).toThrow();
      expect(source.suspended).toBe(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not revive a document destroyed while disk work is pending", async () => {
    const doc = document("a.txt");
    const effect = move("a.txt", "b.txt");
    const operation = registry.beginFileMove([effect]);
    doc.registration.dispose();
    await operation.complete([effect]);
    expect(doc.path).toBe(absolute("a.txt"));
  });
});
