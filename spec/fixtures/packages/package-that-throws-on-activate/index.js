module.exports = {
  restoreSessionState() {},
  activate() {
    throw new Error("Top that");
  },
  deactivate() {},
  serializeSessionState() {},
};
