module.exports = {
  activateCallCount: 0,
  openerCount: 0,

  activate() {
    this.activateCallCount++;
    lumine.workspace.addOpener((filePath) => {
      if (filePath === "lumine://fictitious") {
        this.openerCount++;
      }
    });
  },
};
