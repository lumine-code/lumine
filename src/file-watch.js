function activeClient() {
  const client = globalThis.lumine?.fileWatchClient;
  if (!client) throw new Error("File watching requires an active Lumine environment");
  return client;
}

/**
 * @public
 * @status public
 *
 * Observe a fixed file path, including deletion and recreation. External
 * renames never change the observed path. Changes are hints to reread the file;
 * an invalidation requires a reread after observation has recovered.
 *
 * @param {String} filePath - The path to observe, resolved to an absolute path.
 * @returns {FileWatchHandle} A synchronous handle with ready and closed promises.
 */
function watchFile(filePath) {
  return activeClient().watchFile(filePath);
}

/**
 * @public
 * @status public
 *
 * Observe a fixed directory and its direct children, or its entire tree.
 * Missing directories remain observed through their nearest existing ancestor.
 *
 * @param {String} directoryPath - The directory path to observe.
 * @param {Object} options - Observation options.
 * @param {Boolean} [options.recursive=false] - Whether to include descendants.
 * @returns {FileWatchHandle} A synchronous handle with ready and closed promises.
 */
function watchDirectory(directoryPath, options) {
  return activeClient().watchDirectory(directoryPath, options);
}

module.exports = { watchFile, watchDirectory };
