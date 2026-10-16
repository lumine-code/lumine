module.exports = {
  restoreSessionState({ someNumber } = {}) {
    this.someNumber = someNumber ?? 1;
  },

  serializeSessionState() {
    return { someNumber: this.someNumber };
  },
};
