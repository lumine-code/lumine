"use strict";

const crypto = require("node:crypto");

const WINDOW_KEY =
  /^editor-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([0-9a-f]{40})$/i;
const PROJECT_KEY = /^editor-([0-9a-f]{40})$/i;
const DELETE_BATCH_SIZE = 8;
const DELETE_BATCH_BYTES = 1024 * 1024;
const DIRTY_FLAGS = ["modified", "dirty", "isModified"];
const RAW_CONTENT_KEYS = new Set([
  "text",
  "content",
  "contents",
  "source",
  "rows",
  "cells",
  "notebookData",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function windowKeyParts(key) {
  if (typeof key !== "string") return null;
  const match = WINDOW_KEY.exec(key);
  return match && { windowStateId: match[1].toLowerCase(), projectDigest: match[2].toLowerCase() };
}

function hasTables(db) {
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  );
  return tables.has("Environments1") && tables.has("ProjectStateIndex1");
}

function readIndexProtection(db) {
  const existingKeys = new Set(
    db
      .prepare("SELECT key FROM Environments1")
      .all()
      .map((row) => row.key),
  );
  const referencedKeys = new Set();
  const brokenProjects = new Set();
  const indexedProjectKeys = new Map();
  for (const row of db.prepare("SELECT key, value FROM ProjectStateIndex1").all()) {
    const project = typeof row.key === "string" && PROJECT_KEY.exec(row.key);
    if (!project) continue;
    const projectDigest = project[1].toLowerCase();
    let pointer;
    try {
      pointer = JSON.parse(row.value)?.value;
    } catch {
      brokenProjects.add(projectDigest);
      continue;
    }
    const target = windowKeyParts(pointer);
    if (typeof pointer === "string" && existingKeys.has(pointer)) referencedKeys.add(pointer);
    if (!target || target.projectDigest !== projectDigest || !existingKeys.has(pointer)) {
      // A corrupt or dangling pointer cannot establish which private copy is
      // safe to discard. Leave this project's snapshots for a later save.
      brokenProjects.add(projectDigest);
    } else {
      indexedProjectKeys.set(projectDigest, pointer);
    }
  }
  return { referencedKeys, brokenProjects, indexedProjectKeys };
}

function parseSnapshot(serialized) {
  let state;
  try {
    state = JSON.parse(serialized)?.value;
  } catch {
    return null;
  }
  // Unknown state versions may use a different recovery contract. Retention
  // must not turn an unreadable snapshot into permanent loss of user work.
  if (!isRecord(state) || state.version !== 1) return null;
  if (
    state.project != null &&
    (!isRecord(state.project) || !Array.isArray(state.project.buffers))
  ) {
    return null;
  }
  if (
    state.project?.buffers.some(
      (buffer) =>
        !isRecord(buffer) || (buffer.filePath != null && typeof buffer.filePath !== "string"),
    )
  )
    return null;
  if (state.workspace != null && !isRecord(state.workspace)) return null;
  if (
    state.workspace?.paneContainers != null &&
    (!isRecord(state.workspace.paneContainers) ||
      Object.values(state.workspace.paneContainers).some(
        (container) => container != null && !isRecord(container),
      ))
  )
    return null;
  if (state.packageStates != null && !isRecord(state.packageStates)) return null;
  return state;
}

function someObject(root, predicate) {
  const pending = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object") continue;
    if (predicate(value)) return true;
    for (const child of Object.values(value)) {
      if (child !== null && typeof child === "object") pending.push(child);
    }
  }
  return false;
}

function containsRecovery(state) {
  if (
    state.project?.buffers.some(
      (buffer) => !isRecord(buffer) || Object.hasOwn(buffer, "text") || !buffer.filePath,
    )
  ) {
    return true;
  }
  if (
    someObject(state, (value) => {
      if (DIRTY_FLAGS.some((flag) => value[flag] === true)) return true;
      if (value.fileState != null && value.fileState !== "unmodified") return true;
      // A source controller can retain an untitled buffer outside Project.
      // An explicitly clean projection is rebuildable; an unclassified one
      // may be the only copy of edits from an older package generation.
      if (
        Object.hasOwn(value, "text") &&
        Object.hasOwn(value, "defaultMarkerLayerId") &&
        !value.filePath &&
        value.fileState !== "unmodified"
      ) {
        return true;
      }
      return false;
    })
  ) {
    return true;
  }
  // Pane items may own documents outside the core buffer registry. Unknown
  // serialized source, cell or row data is preserved rather than assuming a
  // package can reconstruct it from disk.
  return someObject(state.workspace, (value) =>
    Object.entries(value).some(
      ([key, content]) =>
        RAW_CONTENT_KEYS.has(key) && content != null && typeof content !== "number",
    ),
  );
}

function fingerprintSnapshot(state) {
  return crypto.createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

function fingerprintSerialized(serialized) {
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

function readReferencedFingerprints(db, indexedProjectKeys, projectDigests, recoveryHashes = null) {
  const fingerprints = new Map();
  const readState = db.prepare("SELECT rowid, value FROM Environments1 WHERE key = ?");
  for (const digest of projectDigests) {
    const key = indexedProjectKeys.get(digest);
    if (!key) continue;
    const row = readState.get(key);
    if (!row) continue;
    const state = parseSnapshot(row.value);
    if (state) {
      const hash = fingerprintSnapshot(state);
      fingerprints.set(digest, {
        key,
        rowid: row.rowid,
        hash,
        ...(recoveryHashes?.get(digest)?.has(hash) ? { serialized: row.value } : {}),
      });
    }
  }
  return fingerprints;
}

function collectRetiredSnapshots(db) {
  if (!hasTables(db)) return [];
  const { referencedKeys, brokenProjects, indexedProjectKeys } = readIndexProtection(db);
  const readState = db.prepare("SELECT value FROM Environments1 WHERE key = ? AND rowid = ?");
  const candidates = [];
  const referenceFingerprints = new Map();
  for (const row of db.prepare("SELECT key, rowid FROM Environments1").all()) {
    const parts = windowKeyParts(row.key);
    if (!parts || referencedKeys.has(row.key) || brokenProjects.has(parts.projectDigest)) continue;
    const stored = readState.get(row.key, row.rowid);
    if (!stored) continue;
    const state = parseSnapshot(stored.value);
    if (!state) continue;
    const candidate = {
      key: row.key,
      rowid: row.rowid,
      windowStateId: parts.windowStateId,
      serializedFingerprint: fingerprintSerialized(stored.value),
    };
    if (containsRecovery(state)) {
      if (!referenceFingerprints.has(parts.projectDigest)) {
        const references = readReferencedFingerprints(db, indexedProjectKeys, [
          parts.projectDigest,
        ]);
        referenceFingerprints.set(parts.projectDigest, references.get(parts.projectDigest) ?? null);
      }
      const reference = referenceFingerprints.get(parts.projectDigest);
      const fingerprint = fingerprintSnapshot(state);
      if (!reference || reference.hash !== fingerprint) continue;
      candidate.recoveryFingerprint = fingerprint;
    }
    candidates.push(candidate);
  }
  return candidates;
}

function pruneRetiredSnapshots(db, candidates, { protectedWindowIds = [] } = {}) {
  const stats = {
    removed: 0,
    skippedProtected: 0,
    skippedChanged: 0,
    skippedReferenced: 0,
    skippedBrokenIndex: 0,
    skippedRecovery: 0,
  };
  if (!hasTables(db)) return stats;
  const protectedIds = new Set(Array.from(protectedWindowIds, (id) => String(id).toLowerCase()));
  const readRow = db.prepare("SELECT rowid, value FROM Environments1 WHERE key = ?");
  const unchangedReference = db.prepare(
    "SELECT rowid FROM Environments1 WHERE key = ? AND rowid = ? AND value = ?",
  );
  const deleteRow = db.prepare(
    "DELETE FROM Environments1 WHERE key = ? AND rowid = ? AND value = ?",
  );
  let offset = 0;
  while (offset < candidates.length) {
    const batch = [];
    let batchBytes = 0;
    const recoveryHashes = new Map();
    while (
      offset < candidates.length &&
      batch.length < DELETE_BATCH_SIZE &&
      batchBytes < DELETE_BATCH_BYTES
    ) {
      const candidate = candidates[offset++];
      const current = readRow.get(candidate.key);
      const readable =
        current && (typeof current.value === "string" || Buffer.isBuffer(current.value));
      const unchanged =
        readable &&
        current.rowid === candidate.rowid &&
        fingerprintSerialized(current.value) === candidate.serializedFingerprint;
      batch.push({ candidate, ...(unchanged ? { serialized: current.value } : {}) });
      if (readable) batchBytes += Buffer.byteLength(current.value);
      if (candidate.recoveryFingerprint) {
        const parts = windowKeyParts(candidate.key);
        if (parts) {
          if (!recoveryHashes.has(parts.projectDigest))
            recoveryHashes.set(parts.projectDigest, new Set());
          recoveryHashes.get(parts.projectDigest).add(candidate.recoveryFingerprint);
        }
      }
    }
    // Reading and hashing potentially large recovery payloads stays outside
    // the write lock. Row identities and index keys are checked again below.
    const references = readReferencedFingerprints(
      db,
      readIndexProtection(db).indexedProjectKeys,
      recoveryHashes.keys(),
      recoveryHashes,
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      const { referencedKeys, brokenProjects, indexedProjectKeys } = readIndexProtection(db);
      for (const { candidate, serialized } of batch) {
        const parts = windowKeyParts(candidate.key);
        if (!parts || parts.windowStateId !== candidate.windowStateId?.toLowerCase()) {
          stats.skippedChanged++;
        } else if (protectedIds.has(parts.windowStateId)) {
          stats.skippedProtected++;
        } else if (referencedKeys.has(candidate.key)) {
          stats.skippedReferenced++;
        } else if (brokenProjects.has(parts.projectDigest)) {
          stats.skippedBrokenIndex++;
        } else {
          // StateStore uses REPLACE, so a save/adoption gives a row a new
          // identity. The fingerprint and exact-value delete guard also catch
          // direct UPDATEs and rowid reuse after a clear or deletion.
          if (serialized === undefined) {
            stats.skippedChanged++;
          } else {
            if (candidate.recoveryFingerprint) {
              const reference = references.get(parts.projectDigest);
              const referencedRow =
                reference?.serialized !== undefined &&
                unchangedReference.get(reference.key, reference.rowid, reference.serialized);
              if (
                !reference ||
                indexedProjectKeys.get(parts.projectDigest) !== reference.key ||
                referencedRow?.rowid !== reference.rowid ||
                reference.hash !== candidate.recoveryFingerprint
              ) {
                stats.skippedRecovery++;
                continue;
              }
            }
            const result = deleteRow.run(candidate.key, candidate.rowid, serialized);
            stats.removed += result.changes;
            if (!result.changes) stats.skippedChanged++;
          }
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return stats;
}

module.exports = { collectRetiredSnapshots, pruneRetiredSnapshots };
