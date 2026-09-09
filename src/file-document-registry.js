const path = require("node:path");
const fs = require("node:fs");
const { Disposable } = require("@lumine-code/event-kit");

function relativeWithin(parent, candidate) {
  if (candidate === parent) return "";
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return candidate.startsWith(prefix) ? candidate.slice(prefix.length) : null;
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  let current = resolved;
  const missing = [];
  while (true) {
    try {
      return path.join(fs.realpathSync.native(current), ...missing);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function normalizeMoves(moves) {
  if (!Array.isArray(moves)) throw new TypeError("File moves must be an array");
  return moves.map(({ oldPath, newPath, isDirectory = false }) => {
    if (typeof oldPath !== "string" || !oldPath || typeof newPath !== "string" || !newPath) {
      throw new TypeError("A file move requires oldPath and newPath");
    }
    return { oldPath: path.resolve(oldPath), newPath: path.resolve(newPath), isDirectory };
  });
}

function movedPath(filePath, moves) {
  let target = filePath;
  for (const move of moves) {
    const relative = relativeWithin(move.oldPath, target);
    if (relative === "" || (move.isDirectory && relative !== null)) {
      target = relative ? path.join(move.newPath, relative) : move.newPath;
    }
  }
  return target;
}

module.exports = class FileDocumentRegistry {
  constructor() {
    this.documents = new Map();
  }

  register(descriptor) {
    if (
      !descriptor?.owner ||
      typeof descriptor.getPath !== "function" ||
      typeof descriptor.setPath !== "function"
    ) {
      throw new TypeError("A file document requires owner, getPath and setPath");
    }
    let entry = this.documents.get(descriptor.owner);
    if (!entry) {
      entry = { descriptor, refs: 0 };
      this.documents.set(descriptor.owner, entry);
    }
    entry.refs++;
    return new Disposable(() => {
      if (--entry.refs === 0 && this.documents.get(descriptor.owner) === entry) {
        this.documents.delete(descriptor.owner);
      }
    });
  }

  beginFileMove(plannedRenames) {
    const requested = normalizeMoves(plannedRenames);
    const planned = requested.map((move) => ({ ...move, oldPath: canonicalPath(move.oldPath) }));
    const all = [...this.documents.values()].flatMap((entry) => {
      const current = entry.descriptor.getPath();
      return current ? [{ entry, original: canonicalPath(current) }] : [];
    });
    const affected = all.filter(({ original }) => movedPath(original, planned) !== original);
    const affectedEntries = new Set(affected.map(({ entry }) => entry));
    const destinations = new Set();
    for (const { original } of affected) {
      const target = canonicalPath(movedPath(original, planned));
      if (
        destinations.has(target) ||
        all.some(({ entry, original: other }) => !affectedEntries.has(entry) && other === target)
      ) {
        throw new Error(`Cannot move a document onto another open document: ${target}`);
      }
      destinations.add(target);
    }
    const begun = [];
    try {
      for (const record of affected) {
        record.entry.descriptor.beginFileOperation?.();
        begun.push(record);
      }
    } catch (error) {
      for (const { entry } of begun)
        void Promise.resolve(entry.descriptor.endFileOperation?.()).catch(() => {});
      throw error;
    }
    let completion;
    return {
      complete: (confirmedRenames = []) => {
        if (completion) return completion;
        completion = (async () => {
          const failures = [];
          try {
            const confirmed = normalizeMoves(confirmedRenames).map((move) => {
              // The source may no longer exist. Resolve its spelling using the
              // pre-operation snapshot, including children of planned directory moves.
              for (let i = 0; i < requested.length; i++) {
                const relative = relativeWithin(requested[i].oldPath, move.oldPath);
                if (relative === "" || (requested[i].isDirectory && relative !== null)) {
                  return {
                    ...move,
                    oldPath: relative
                      ? path.join(planned[i].oldPath, relative)
                      : planned[i].oldPath,
                  };
                }
              }
              return move;
            });
            for (const { entry, original } of affected) {
              const descriptor = entry.descriptor;
              if (this.documents.get(descriptor.owner) !== entry) continue;
              const target = movedPath(original, confirmed);
              if (target !== original) {
                try {
                  await descriptor.setPath(target);
                } catch (error) {
                  failures.push(error);
                }
              }
            }
          } finally {
            for (const { entry } of begun) {
              if (this.documents.get(entry.descriptor.owner) !== entry) continue;
              try {
                await entry.descriptor.endFileOperation?.();
              } catch (error) {
                failures.push(error);
              }
            }
          }
          if (failures.length)
            throw new AggregateError(failures, "Unable to update moved documents");
        })();
        return completion;
      },
    };
  }

  dispose() {
    this.documents.clear();
  }
};
