module.exports = {
  activateCallCount: 0,

  activate() {
    this.activateCallCount++;
  },

  provideLazyService() {
    return { source: "package-with-activate-on-consume" };
  },
};
