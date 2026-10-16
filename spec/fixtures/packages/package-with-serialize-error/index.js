module.exports = {
  restoreSessionState() {},
  activate() {},

  deactivate() {},

  serializeSessionState() {
    throw new Error("I'm no good at this.");
  },
};
