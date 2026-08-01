const fs = require("fs");
const path = require("path");

const fsp = fs.promises;
const conflictResolvers = new Map();
const cancelledJobs = new Set();
let nextConflictId = 1;

// This module is forked directly instead of running through Task so the worker
// can pause a directory merge for a replace/skip/cancel decision from the UI.
function emit(message) {
  if (process.connected) process.send(message);
}

function serializeError(error) {
  return { message: error.message, code: error.code, stack: error.stack };
}

function isCancelled(jobId) {
  return cancelledJobs.has(jobId);
}

async function statNoException(filePath, method = "lstat") {
  try {
    return await fsp[method](filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function sameFile(sourceStat, destinationStat) {
  return (
    sourceStat &&
    destinationStat &&
    sourceStat.dev === destinationStat.dev &&
    sourceStat.ino === destinationStat.ino
  );
}

function progressReporter(jobId, phase) {
  let entries = 0;
  let lastReport = 0;
  return {
    visit() {
      entries++;
      if (entries !== 1 && entries % 128 !== 0) return true;
      const now = Date.now();
      if (now - lastReport >= 250) {
        lastReport = now;
        emit({ type: "progress", jobId, progress: { phase, entries } });
      }
      return true;
    },
    finish() {
      emit({ type: "progress", jobId, progress: { phase, entries } });
    },
  };
}

async function copyPath(sourcePath, destinationPath, jobId, phase = "copying") {
  if (isCancelled(jobId)) return { cancelled: true };
  const destinationStat = await statNoException(destinationPath);
  if (isCancelled(jobId)) return { cancelled: true };
  if (destinationStat) {
    const error = new Error(`'${destinationPath}' already exists.`);
    error.code = "EEXIST";
    throw error;
  }

  const sourceStat = await fsp.lstat(sourcePath);
  if (isCancelled(jobId)) return { cancelled: true };
  emit({
    type: "progress",
    jobId,
    progress: {
      phase,
      bytesTotal: sourceStat.isFile() ? sourceStat.size : null,
    },
  });

  const progress = progressReporter(jobId, phase);
  await fsp.cp(sourcePath, destinationPath, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter() {
      if (isCancelled(jobId)) return false;
      return progress.visit();
    },
  });
  if (isCancelled(jobId)) {
    await fsp.rm(destinationPath, { recursive: true, force: true });
    return { cancelled: true };
  }
  progress.finish();
  return { copied: true };
}

function askConflict(jobId, conflict) {
  const conflictId = nextConflictId++;
  return new Promise((resolve) => {
    conflictResolvers.set(`${jobId}:${conflictId}`, resolve);
    emit({ type: "conflict", jobId, conflictId, conflict });
  });
}

async function copyThenRemove(sourcePath, destinationPath, jobId) {
  const result = await copyPath(sourcePath, destinationPath, jobId, "copying-to-move");
  if (result.cancelled) return result;
  await fsp.rm(sourcePath, { recursive: true, force: false });
  return { moved: true };
}

async function renameFresh(sourcePath, destinationPath, jobId, allowCancellation = true) {
  if (allowCancellation && isCancelled(jobId)) return { cancelled: true };
  await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
  try {
    await fsp.rename(sourcePath, destinationPath);
    return { moved: true };
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    return copyThenRemove(sourcePath, destinationPath, jobId);
  }
}

async function movePath(sourcePath, destinationPath, jobId, relativeTo) {
  if (isCancelled(jobId)) return { cancelled: true };
  const sourceStat = await fsp.lstat(sourcePath);
  const destinationStat = await statNoException(destinationPath);

  if (!destinationStat) {
    return renameFresh(sourcePath, destinationPath, jobId);
  }

  const followedSourceStat = await statNoException(sourcePath, "stat");
  const followedDestinationStat = await statNoException(destinationPath, "stat");
  if (sameFile(followedSourceStat, followedDestinationStat)) {
    await fsp.rename(sourcePath, destinationPath);
    return { moved: true };
  }

  if (sourceStat.isDirectory() && destinationStat.isDirectory()) {
    let skipped = false;
    let partiallyMoved = false;
    for (const entry of await fsp.readdir(sourcePath)) {
      const result = await movePath(
        path.join(sourcePath, entry),
        path.join(destinationPath, entry),
        jobId,
        relativeTo,
      );
      if (result.cancelled) {
        return { cancelled: true, partial: partiallyMoved || result.partial === true };
      }
      if (result.skipped) skipped = true;
      if (result.moved || result.partial) partiallyMoved = true;
    }
    if ((await fsp.readdir(sourcePath)).length === 0) {
      await fsp.rmdir(sourcePath);
    } else {
      skipped = true;
    }
    if (skipped) return { skipped: true, partial: true };
    return { moved: true };
  }

  const resolution = await askConflict(jobId, {
    relativePath: path.relative(relativeTo, destinationPath),
    sourcePath,
    destinationPath,
  });
  if (resolution === "cancel") return { cancelled: true };
  if (resolution === "skip") return { skipped: true };

  if (sourceStat.isDirectory() !== destinationStat.isDirectory()) {
    const error = new Error(`Cannot replace '${destinationPath}' with a different entry type.`);
    error.code = sourceStat.isDirectory() ? "ENOTDIR" : "EISDIR";
    throw error;
  }

  await fsp.rm(destinationPath, { recursive: destinationStat.isDirectory(), force: true });
  return renameFresh(sourcePath, destinationPath, jobId, false);
}

async function runJob(message) {
  const { jobId, operation, sourcePath, destinationPath } = message;
  if (operation === "copy") {
    return copyPath(sourcePath, destinationPath, jobId);
  }
  if (operation === "move") {
    emit({ type: "progress", jobId, progress: { phase: "moving" } });
    return movePath(sourcePath, destinationPath, jobId, path.dirname(destinationPath));
  }
  throw new Error(`Unknown file operation '${operation}'.`);
}

process.on("message", async (message) => {
  if (message?.type === "cancel") {
    cancelledJobs.add(message.jobId);
    for (const [key, resolve] of conflictResolvers) {
      if (!key.startsWith(`${message.jobId}:`)) continue;
      conflictResolvers.delete(key);
      resolve("cancel");
    }
    return;
  }
  if (message?.type === "resolve-conflict") {
    const key = `${message.jobId}:${message.conflictId}`;
    const resolve = conflictResolvers.get(key);
    if (resolve) {
      conflictResolvers.delete(key);
      resolve(message.resolution);
    }
    return;
  }
  if (message?.type !== "run") return;

  try {
    const result = await runJob(message);
    emit({ type: "complete", jobId: message.jobId, result });
  } catch (error) {
    emit({ type: "error", jobId: message.jobId, error: serializeError(error) });
  } finally {
    cancelledJobs.delete(message.jobId);
  }
});

module.exports = { copyPath, movePath, runJob };
