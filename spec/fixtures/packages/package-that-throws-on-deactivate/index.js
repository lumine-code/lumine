module.exports = {
  restoreSessionState() {},
  activate() {},
  deactivate() {
    throw new Error("Top that");
  },
  serializeSessionState() {},
};
