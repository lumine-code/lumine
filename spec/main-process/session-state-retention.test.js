const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const { DatabaseSync } = require("node:sqlite");
const {
  collectRetiredSnapshots,
  pruneRetiredSnapshots,
} = require("../../src/session-state-retention");

describe("session state retention", function () {
  const firstId = "11111111-1111-4111-8111-111111111111";
  const secondId = "22222222-2222-4222-8222-222222222222";
  const retiredId = "33333333-3333-4333-8333-333333333333";
  const firstProject = "a".repeat(40);
  const secondProject = "b".repeat(40);
  let db, directory;

  beforeEach(function () {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-session-retention-"));
    db = new DatabaseSync(path.join(directory, "session-store.db"));
    db.exec("CREATE TABLE Environments1 (key VARCHAR UNIQUE, value JSON)");
    db.exec("CREATE TABLE ProjectStateIndex1 (key VARCHAR UNIQUE, value JSON)");
  });

  afterEach(function () {
    db.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function key(id = retiredId, project = firstProject) {
    return `editor-${id}-${project}`;
  }

  function state(overrides = {}) {
    return { version: 1, project: { buffers: [] }, workspace: {}, packageStates: {}, ...overrides };
  }

  function save(snapshotKey, value = state()) {
    db.prepare("REPLACE INTO Environments1 VALUES (?, ?)").run(
      snapshotKey,
      JSON.stringify({ value }),
    );
  }

  function point(project, snapshotKey) {
    db.prepare("REPLACE INTO ProjectStateIndex1 VALUES (?, ?)").run(
      `editor-${project}`,
      JSON.stringify({ value: snapshotKey }),
    );
  }

  function exists(snapshotKey) {
    return Boolean(db.prepare("SELECT key FROM Environments1 WHERE key = ?").get(snapshotKey));
  }

  it("removes only retired modern window rows and keeps the latest project state", function () {
    const latest = key(firstId);
    save(latest);
    save(key());
    save("history-manager", { projects: [] });
    save(`editor-${firstProject}`);
    save("package-private-state");
    point(firstProject, latest);

    const candidates = collectRetiredSnapshots(db);
    assert.deepEqual(
      candidates.map((row) => row.key),
      [key()],
    );
    assert.deepEqual(Object.keys(candidates[0]).sort(), [
      "key",
      "rowid",
      "serializedFingerprint",
      "windowStateId",
    ]);
    assert.equal(pruneRetiredSnapshots(db, candidates, {}).removed, 1);
    for (const kept of [
      latest,
      "history-manager",
      `editor-${firstProject}`,
      "package-private-state",
    ]) {
      assert.equal(exists(kept), true);
    }
  });

  it("keeps independent states for two live windows on the same project", function () {
    save(key(firstId));
    save(key(secondId));
    save(key());
    point(firstProject, key(secondId));

    const result = pruneRetiredSnapshots(db, collectRetiredSnapshots(db), {
      protectedWindowIds: new Set([firstId, secondId]),
    });
    assert.equal(result.removed, 1);
    assert.equal(result.skippedProtected, 1);
    assert.equal(exists(key(firstId)), true);
    assert.equal(exists(key(secondId)), true);
  });

  it("keeps every project history belonging to an active or restored identity", function () {
    save(key(firstId));
    save(key(firstId, secondProject));
    save(key());
    save(key(retiredId, secondProject));
    point(firstProject, key());
    point(secondProject, key(retiredId, secondProject));

    const result = pruneRetiredSnapshots(db, collectRetiredSnapshots(db), {
      protectedWindowIds: [firstId.toUpperCase()],
    });
    assert.equal(result.removed, 0);
    assert.equal(result.skippedProtected, 2);
  });

  it("preserves modified, conflicted, removed and untitled core buffers", function () {
    for (const [index, buffer] of [
      { filePath: "/modified.txt", fileState: "modified", text: "unsaved" },
      { filePath: "/conflicted.txt", fileState: "conflicted" },
      { filePath: "/removed.txt", fileState: "removed" },
      { text: "untitled" },
      { text: "", fileState: "unmodified" },
    ].entries()) {
      save(key(retiredId, String(index).repeat(40)), state({ project: { buffers: [buffer] } }));
    }
    assert.deepEqual(collectRetiredSnapshots(db), []);
  });

  it("preserves dirty tables and unknown pane content outside core buffers", function () {
    const items = [
      {
        deserializer: "table-editor/DelimitedTextEditor",
        editor: { displayTable: { table: { modified: true, rows: [["unsaved"]] } } },
      },
      { deserializer: "CustomDocument", content: "unclassified user work" },
      { deserializer: "CustomDocument", rows: [["user work"]] },
    ];
    for (const [index, item] of items.entries()) {
      save(
        key(retiredId, String(index).repeat(40)),
        state({
          workspace: { paneContainers: { center: { root: { items: [item] } } } },
        }),
      );
    }
    assert.deepEqual(collectRetiredSnapshots(db), []);
  });

  it("preserves nested Jupyter document and source-buffer recovery states", function () {
    save(
      key(),
      state({
        packageStates: { "jupyter-view": { documents: { document: { fileState: "modified" } } } },
      }),
    );
    save(
      key(retiredId, secondProject),
      state({
        packageStates: {
          "jupyter-view": {
            documents: {
              document: { sourceControllerState: { bufferState: { fileState: "modified" } } },
            },
          },
        },
      }),
    );
    assert.deepEqual(collectRetiredSnapshots(db), []);
  });

  it("does not mistake clean package caches or source projections for recovery", function () {
    save(
      key(),
      state({
        project: { buffers: [{ filePath: "/saved.txt", fileState: "unmodified" }] },
        packageStates: {
          cache: { content: ["rebuildable"], rows: [["rebuildable"]] },
          source: {
            bufferState: { text: "projection", defaultMarkerLayerId: 0, fileState: "unmodified" },
          },
        },
      }),
    );
    assert.equal(collectRetiredSnapshots(db).length, 1);
  });

  it("leaves malformed snapshots and unknown state versions untouched", function () {
    db.prepare("REPLACE INTO Environments1 VALUES (?, ?)").run(key(), "{broken");
    save(key(firstId), state({ version: 2 }));
    save(key(secondId), state({ project: { buffers: "not an array" } }));
    save(key(retiredId, secondProject), state({ workspace: { paneContainers: "corrupt" } }));
    assert.deepEqual(collectRetiredSnapshots(db), []);
  });

  it("protects all copies of a project whose index is broken or dangling", function () {
    save(key());
    save(key(firstId));
    db.prepare("REPLACE INTO ProjectStateIndex1 VALUES (?, ?)").run(
      `editor-${firstProject}`,
      "bad JSON",
    );
    assert.deepEqual(collectRetiredSnapshots(db), []);
    point(firstProject, key(secondId));
    assert.deepEqual(collectRetiredSnapshots(db), []);
  });

  it("rechecks index references and replaced row identities before pruning", function () {
    save(key());
    save(key(firstId, secondProject));
    const candidates = collectRetiredSnapshots(db);
    point(firstProject, key());
    save(key(firstId, secondProject), state({ project: { buffers: [{ text: "new edits" }] } }));

    const result = pruneRetiredSnapshots(db, candidates, {});
    assert.equal(result.removed, 0);
    assert.equal(result.skippedReferenced, 1);
    assert.equal(result.skippedChanged, 1);
    assert.equal(exists(key()), true);
    assert.equal(exists(key(firstId, secondProject)), true);
  });

  it("rechecks newly broken index entries before pruning", function () {
    save(key());
    const candidates = collectRetiredSnapshots(db);
    point(firstProject, "missing-state");
    const result = pruneRetiredSnapshots(db, candidates, {});
    assert.equal(result.removed, 0);
    assert.equal(result.skippedBrokenIndex, 1);
  });

  it("bounds exact recovery copies while keeping the indexed and live snapshots", function () {
    const recovery = state({ project: { buffers: [{ text: "unsaved work" }] } });
    save(key(), recovery);
    save(key(firstId), recovery);
    save(key(secondId), recovery);
    point(firstProject, key(secondId));
    const candidates = collectRetiredSnapshots(db);
    assert.equal(candidates.length, 2);
    assert.equal(typeof candidates[0].recoveryFingerprint, "string");

    const result = pruneRetiredSnapshots(db, candidates, { protectedWindowIds: [firstId] });
    assert.equal(result.removed, 1);
    assert.equal(exists(key()), false);
    assert.equal(exists(key(firstId)), true);
    assert.equal(exists(key(secondId)), true);
  });

  it("deduplicates recovery copies with different stored-at envelope metadata", function () {
    const recovery = state({ project: { buffers: [{ text: "unsaved work" }] } });
    const insert = db.prepare("REPLACE INTO Environments1 VALUES (?, ?)");
    insert.run(key(), JSON.stringify({ value: recovery, storedAt: "earlier save" }));
    insert.run(key(firstId), JSON.stringify({ value: recovery, storedAt: "later save" }));
    point(firstProject, key(firstId));
    assert.equal(pruneRetiredSnapshots(db, collectRetiredSnapshots(db), {}).removed, 1);
    assert.equal(exists(key(firstId)), true);
  });

  it("retains the old recovery copy when the latest dirty state changes before pruning", function () {
    const recovery = state({ project: { buffers: [{ text: "original work" }] } });
    save(key(), recovery);
    save(key(firstId), recovery);
    point(firstProject, key(firstId));
    const candidates = collectRetiredSnapshots(db);
    assert.equal(candidates.length, 1);
    save(key(firstId), state({ project: { buffers: [{ text: "different work" }] } }));

    const result = pruneRetiredSnapshots(db, candidates, {});
    assert.equal(result.removed, 0);
    assert.equal(result.skippedRecovery, 1);
    assert.equal(exists(key()), true);
  });

  it("does not equate recovery state that differs in any persisted field", function () {
    const recovery = state({ project: { buffers: [{ text: "same work" }] }, marker: "original" });
    save(key(), recovery);
    save(key(firstId), { ...recovery, marker: "different" });
    point(firstProject, key(firstId));
    assert.deepEqual(collectRetiredSnapshots(db), []);
  });

  it("rechecks the exact indexed recovery contents inside the deletion transaction", function () {
    const recovery = state({ project: { buffers: [{ text: "old recovery" }] } });
    save(key(), recovery);
    save(key(firstId), recovery);
    point(firstProject, key(firstId));
    const candidates = collectRetiredSnapshots(db);
    const racingDb = {
      prepare: (...args) => db.prepare(...args),
      exec(command) {
        if (command === "BEGIN IMMEDIATE") {
          db.prepare("UPDATE Environments1 SET value = ? WHERE key = ?").run(
            JSON.stringify({
              value: state({ project: { buffers: [{ text: "changed latest" }] } }),
            }),
            key(firstId),
          );
        }
        return db.exec(command);
      },
    };
    const result = pruneRetiredSnapshots(racingDb, candidates, {});
    assert.equal(result.removed, 0);
    assert.equal(result.skippedRecovery, 1);
    assert.equal(exists(key()), true);
  });

  it("does not delete snapshots created after candidate collection", function () {
    save(key());
    const candidates = collectRetiredSnapshots(db);
    save(key(firstId));
    assert.equal(pruneRetiredSnapshots(db, candidates, {}).removed, 1);
    assert.equal(exists(key(firstId)), true);
  });

  it("preserves new contents after deletion and rowid reuse for the same key", function () {
    save(key());
    const candidates = collectRetiredSnapshots(db);
    db.prepare("DELETE FROM Environments1 WHERE key = ?").run(key());
    save(key(), state({ project: { buffers: [{ text: "new unsaved text" }] } }));
    assert.equal(
      db.prepare("SELECT rowid FROM Environments1 WHERE key = ?").get(key()).rowid,
      candidates[0].rowid,
    );
    assert.equal(pruneRetiredSnapshots(db, candidates, {}).skippedChanged, 1);
    assert.equal(exists(key()), true);
  });

  it("preserves contents updated in place without changing rowid", function () {
    save(key());
    const candidates = collectRetiredSnapshots(db);
    db.prepare("UPDATE Environments1 SET value = ? WHERE key = ?").run(
      JSON.stringify({ value: state({ project: { buffers: [{ text: "new work" }] } }) }),
      key(),
    );
    assert.equal(pruneRetiredSnapshots(db, candidates, {}).skippedChanged, 1);
    assert.equal(exists(key()), true);
  });

  it("rechecks exact values when a write occurs between batch preparation and its transaction", function () {
    save(key());
    const candidates = collectRetiredSnapshots(db);
    const racingDb = {
      prepare: (...args) => db.prepare(...args),
      exec(command) {
        if (command === "BEGIN IMMEDIATE") {
          db.prepare("UPDATE Environments1 SET value = ? WHERE key = ?").run(
            JSON.stringify({ value: state({ project: { buffers: [{ text: "raced edit" }] } }) }),
            key(),
          );
        }
        return db.exec(command);
      },
    };
    assert.equal(pruneRetiredSnapshots(racingDb, candidates, {}).skippedChanged, 1);
    assert.equal(exists(key()), true);
  });

  it("commits a large deletion separately from later small snapshots", function () {
    save(key(), state({ packageStates: { cache: "x".repeat(1024 * 1024) } }));
    save(key(firstId));
    const commands = [];
    const tracingDb = {
      prepare: (...args) => db.prepare(...args),
      exec(command) {
        commands.push(command);
        return db.exec(command);
      },
    };
    const candidates = collectRetiredSnapshots(db).sort((left) => (left.key === key() ? -1 : 1));
    assert.equal(pruneRetiredSnapshots(tracingDb, candidates, {}).removed, 2);
    assert.equal(commands.filter((command) => command === "COMMIT").length, 2);
  });

  it("does not create tables when called against an unrelated database", function () {
    db.exec("DROP TABLE Environments1");
    db.exec("DROP TABLE ProjectStateIndex1");
    assert.deepEqual(collectRetiredSnapshots(db), []);
    assert.equal(pruneRetiredSnapshots(db, [], {}).removed, 0);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(), []);
  });
});
