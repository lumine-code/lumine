module.exports = class TarRuntimeLoader {
  importArchive() {
    return import("tar");
  }

  load() {
    this.pending ||= Promise.resolve()
      .then(() => this.importArchive())
      .then((namespace) => {
        const archive = namespace.default ?? namespace;
        if (typeof archive.x !== "function") throw new TypeError("Invalid archive extractor.");
        return archive;
      })
      .catch((error) => {
        this.pending = null;
        throw error;
      });
    return this.pending;
  }
};
