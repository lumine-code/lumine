/**
 * @public
 * @status public
 *
 * The mutually exclusive persistence states exposed by file-backed pane items.
 */
class FileState {
  /**
   * @public
   * @status public
   *
   * @returns {String} The document matches its saved base.
   */
  static get UNMODIFIED() {
    return "unmodified";
  }

  /**
   * @public
   * @status public
   *
   * @returns {String} The document has local changes.
   */
  static get MODIFIED() {
    return "modified";
  }

  /**
   * @public
   * @status public
   *
   * @returns {String} The document and its backing file diverged.
   */
  static get CONFLICTED() {
    return "conflicted";
  }

  /**
   * @public
   * @status public
   *
   * @returns {String} The document's backing file no longer exists.
   */
  static get REMOVED() {
    return "removed";
  }
}

// Class accessors are non-enumerable by default. File-state consumers use
// Object.values(FileState) for validation and class generation, so expose the
// four documented constants as a conventional enumerable enum namespace.
for (const name of ["UNMODIFIED", "MODIFIED", "CONFLICTED", "REMOVED"]) {
  const descriptor = Object.getOwnPropertyDescriptor(FileState, name);
  Object.defineProperty(FileState, name, { ...descriptor, enumerable: true });
}

Object.freeze(FileState);

module.exports = FileState;
