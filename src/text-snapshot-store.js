const crypto = require("node:crypto");
const { PieceTree } = require("./text-model");
const { cloneSessionSnapshot } = require("./serialized-text");

const NODE_TABLE = "TextSnapshotNodes1";
const ROOT_TABLE = "TextSnapshotRoots1";
const LEASE_TABLE = "TextSnapshotWriters1";
const META_TABLE = "TextSnapshotMetadata1";
const HASH = /^[0-9a-f]{64}$/;
const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));

function digestNode(text, left, right) {
  return crypto
    .createHash("sha256")
    .update(text == null ? `branch\0${left}\0${right}` : Buffer.concat([Buffer.from([0]), text]))
    .digest("hex");
}

function hasTables(db) {
  return !!db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(NODE_TABLE);
}

function removeReferences(db, table, key) {
  table = table.replace(/^"|"$/g, "");
  if (hasTables(db))
    db.prepare(`DELETE FROM ${ROOT_TABLE} WHERE owner = ? AND key = ?`).run(table, key);
}

// Immutable, content-addressed rope nodes keep every text allocation below
// 64 KiB. A save reuses the identities of unchanged tree branches, so one edit
// does not copy or hash the rest of a large document on the next autosave.
// Nodes commit in bounded batches. The small session record and its root set
// publish in one SQLite transaction, only after all referenced nodes are durable.
class TextSnapshotStore {
  constructor(db, { databasePath } = {}) {
    this.db = db;
    this.databasePath = databasePath;
    db.exec(`CREATE TABLE IF NOT EXISTS ${NODE_TABLE} (
      hash TEXT PRIMARY KEY, text BLOB, left_hash TEXT, right_hash TEXT
    ); CREATE TABLE IF NOT EXISTS ${ROOT_TABLE} (
      owner TEXT, key TEXT, hash TEXT, PRIMARY KEY (owner, key, hash)
    ); CREATE TABLE IF NOT EXISTS ${LEASE_TABLE} (id TEXT PRIMARY KEY, pid INTEGER);
    CREATE TABLE IF NOT EXISTS ${META_TABLE} (id INTEGER PRIMARY KEY, generation INTEGER);
    INSERT OR IGNORE INTO ${META_TABLE} VALUES (1, 0);`);
    this.known = new WeakMap();
    this.preparation = Promise.resolve();
    this.leases = new Set();
    this.writers = new Set();
    this.closed = false;
    this.generation = this.readGeneration();
    this.insertNode = db.prepare(`INSERT OR IGNORE INTO ${NODE_TABLE} VALUES (?, ?, ?, ?)`);
    this.readNode = db.prepare(
      `SELECT text, left_hash, right_hash FROM ${NODE_TABLE} WHERE hash = ?`,
    );
  }

  readGeneration() {
    return this.db.prepare(`SELECT generation FROM ${META_TABLE} WHERE id = 1`).get().generation;
  }

  retainRead() {
    this.assertOpen();
    const lease = crypto.randomUUID();
    this.db.prepare(`INSERT INTO ${LEASE_TABLE} VALUES (?, ?)`).run(lease, process.pid);
    this.leases.add(lease);
    return () => this.releaseLease(lease);
  }

  assertOpen() {
    if (this.closed) throw new Error("Text snapshot store is closed");
  }

  releaseLease(lease) {
    if (!this.leases.has(lease)) return;
    this.db.prepare(`DELETE FROM ${LEASE_TABLE} WHERE id = ?`).run(lease);
    this.leases.delete(lease);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const writer of this.writers) writer.abort();
    // No operation can publish once its owning SQL connection closes. Retire
    // its leases before closing that connection; late finally blocks are inert.
    for (const lease of this.leases) this.releaseLease(lease);
    this.known = new WeakMap();
  }

  prepare(state) {
    this.assertOpen();
    const snapshot = cloneSessionSnapshot(state);
    // A second save must not observe identities queued by a first save whose
    // current batch has not committed yet.
    const operation = this.preparation.then(() => this.prepareSnapshot(snapshot));
    this.preparation = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }

  async prepareSnapshot(state) {
    this.assertOpen();
    const lease = crypto.randomUUID();
    // Lease insertion and generation sampling cannot race the collector:
    // both operations serialize with its BEGIN IMMEDIATE transaction.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO ${LEASE_TABLE} VALUES (?, ?)`).run(lease, process.pid);
      const generation = this.readGeneration();
      if (generation !== this.generation) {
        this.known = new WeakMap();
        this.generation = generation;
      }
      this.db.exec("COMMIT");
      this.leases.add(lease);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const release = () => this.releaseLease(lease);
    const roots = new Set();
    let writer;
    let pending = [],
      bytes = 0;
    const flush = async () => {
      this.assertOpen();
      if (!pending.length) return;
      if (this.databasePath && bytes >= 1024 * 1024 && !writer) {
        const Writer = require("./text-snapshot-writer");
        writer = new Writer(this.databasePath);
        this.writers.add(writer);
      }
      if (writer) {
        await writer.write(pending);
      } else {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          for (const row of pending) this.insertNode.run(...row);
          this.db.exec("COMMIT");
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      }
      pending = [];
      bytes = 0;
      await yieldTurn();
    };
    const writeText = async (tree) => {
      const iterator = tree.snapshotNodes(this.known);
      let next;
      while (!(next = iterator.next()).done) {
        const node = next.value;
        const text = node.text === undefined ? null : Buffer.from(node.text, "utf16le");
        const left = text == null ? this.known.get(node.left) : null;
        const right = text == null ? this.known.get(node.right) : null;
        const hash = digestNode(text, left, right);
        pending.push([hash, text, left, right]);
        this.known.set(node.identity, hash);
        bytes += (text?.length || 0) + 256;
        if (bytes >= 1024 * 1024) await flush();
      }
      const hash = next.value ? this.known.get(next.value) : null;
      if (hash) roots.add(hash);
      return {
        type: "LumineTextSnapshot",
        version: 1,
        hash,
        length: tree.length,
        lines: tree.lineCount,
      };
    };
    const visit = async (value) => {
      if (value instanceof PieceTree) return writeText(value);
      if (Array.isArray(value)) {
        const result = [];
        for (const entry of value) result.push(await visit(entry));
        return result;
      }
      if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
        const result = Object.create(null);
        for (const [key, entry] of Object.entries(value)) result[key] = await visit(entry);
        return result;
      }
      return value;
    };
    try {
      const value = await visit(state);
      await flush();
      await writer?.close();
      this.assertOpen();
      return { value, roots, release };
    } catch (error) {
      // A failed batch must never leave cached identities claiming durability.
      this.known = new WeakMap();
      writer?.abort();
      release();
      throw error;
    } finally {
      if (writer) this.writers.delete(writer);
    }
  }

  publishReferences(owner, key, roots) {
    owner = owner.replace(/^"|"$/g, "");
    removeReferences(this.db, owner, key);
    const insert = this.db.prepare(`INSERT INTO ${ROOT_TABLE} VALUES (?, ?, ?)`);
    for (const hash of roots) insert.run(owner, key, hash);
  }

  createReader() {
    const cache = new Map();
    const visiting = new Set();
    const read = (hash) => {
      if (!HASH.test(hash)) throw new Error("Invalid text snapshot reference");
      if (cache.has(hash)) return cache.get(hash);
      if (visiting.has(hash)) throw new Error("Cyclic text snapshot");
      const row = this.readNode.get(hash);
      if (!row) throw new Error(`Missing text snapshot node ${hash}`);
      const text = row.text == null ? null : Buffer.from(row.text);
      if (text && (text.length === 0 || text.length > 65536 || text.length % 2))
        throw new Error("Invalid text snapshot byte length");
      if (
        (text && (row.left_hash != null || row.right_hash != null)) ||
        (!text && (!HASH.test(row.left_hash) || !HASH.test(row.right_hash))) ||
        visiting.size > 128
      )
        throw new Error("Invalid text snapshot node structure");
      if (digestNode(text, row.left_hash, row.right_hash) !== hash)
        throw new Error("Text snapshot checksum mismatch");
      visiting.add(hash);
      return { row, text };
    };
    const finish = (hash, text, left, right) => {
      const tree = PieceTree.fromSnapshotNode(text?.toString("utf16le"), left, right);
      cache.set(hash, tree);
      visiting.delete(hash);
      tree.rememberSnapshotIdentity(this.known, hash);
      return tree;
    };
    let work = 0;
    const load = async (hash) => {
      const node = read(hash);
      if (node instanceof PieceTree) return node;
      work += (node.text?.length || 0) + 256;
      if (work >= 256 * 1024) {
        work = 0;
        await yieldTurn();
      }
      const left = node.text ? null : await load(node.row.left_hash);
      const right = node.text ? null : await load(node.row.right_hash);
      return finish(hash, node.text, left, right);
    };
    const loadSync = (hash) => {
      const node = read(hash);
      if (node instanceof PieceTree) return node;
      return finish(
        hash,
        node.text,
        node.text ? null : loadSync(node.row.left_hash),
        node.text ? null : loadSync(node.row.right_hash),
      );
    };
    return { load, loadSync };
  }

  validateReference(value, tree) {
    if (value.version !== 1 || tree.length !== value.length || tree.lineCount !== value.lines)
      throw new Error("Invalid text snapshot metadata");
    return tree;
  }

  validateDescriptor(value) {
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.length) ||
      value.length < 0 ||
      !Number.isSafeInteger(value.lines) ||
      value.lines < 1 ||
      value.lines > value.length + 1 ||
      (value.length === 0 ? value.hash !== null : !HASH.test(value.hash))
    )
      throw new Error("Invalid text snapshot metadata");
  }

  async restore(state) {
    const { load } = this.createReader();
    const visit = async (value) => {
      if (value?.type === "LumineTextSnapshot") {
        this.validateDescriptor(value);
        return this.validateReference(
          value,
          value.hash == null ? new PieceTree() : await load(value.hash),
        );
      }
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) value[i] = await visit(value[i]);
      } else if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
        for (const key of Object.keys(value)) value[key] = await visit(value[key]);
      }
      return value;
    };
    return visit(state);
  }

  restoreSync(state) {
    const { loadSync } = this.createReader();
    const visit = (value) => {
      if (value?.type === "LumineTextSnapshot") {
        this.validateDescriptor(value);
        return this.validateReference(
          value,
          value.hash == null ? new PieceTree() : loadSync(value.hash),
        );
      }
      if (Array.isArray(value)) return value.map(visit);
      if (value && typeof value === "object" && !Buffer.isBuffer(value))
        for (const key of Object.keys(value)) value[key] = visit(value[key]);
      return value;
    };
    return visit(state);
  }
}

// Run in the existing maintenance child. Never expire a live writer by age:
// suspended machines, slow disks, and debugger pauses must remain safe. PID
// reuse conservatively delays collection; a later sweep recovers those nodes.
function pruneUnreferencedText(db) {
  if (!hasTables(db)) return { removedTextNodes: 0 };
  db.exec("BEGIN IMMEDIATE");
  try {
    let active = false;
    for (const lease of db.prepare(`SELECT id, pid FROM ${LEASE_TABLE}`).all()) {
      try {
        process.kill(lease.pid, 0);
        active = true;
      } catch (error) {
        if (error.code === "ESRCH")
          db.prepare(`DELETE FROM ${LEASE_TABLE} WHERE id = ?`).run(lease.id);
        else active = true;
      }
    }
    let removedTextNodes = 0;
    if (!active) {
      // UNION deduplicates shared subtrees and terminates even on corrupt cycles.
      const result = db
        .prepare(
          `WITH RECURSIVE reachable(hash) AS (
        SELECT hash FROM ${ROOT_TABLE}
        UNION SELECT n.left_hash FROM ${NODE_TABLE} n JOIN reachable r ON n.hash = r.hash WHERE n.left_hash IS NOT NULL
        UNION SELECT n.right_hash FROM ${NODE_TABLE} n JOIN reachable r ON n.hash = r.hash WHERE n.right_hash IS NOT NULL
      ) DELETE FROM ${NODE_TABLE} WHERE hash NOT IN (SELECT hash FROM reachable)`,
        )
        .run();
      removedTextNodes = result.changes;
      if (removedTextNodes)
        db.exec(`UPDATE ${META_TABLE} SET generation = generation + 1 WHERE id = 1`);
    }
    db.exec("COMMIT");
    return { removedTextNodes };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

module.exports = { TextSnapshotStore, removeReferences, pruneUnreferencedText };
