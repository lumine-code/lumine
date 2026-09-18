module.exports = {
  activateCallCount: 0,
  openerCount: 0,

  activate() {
    this.activateCallCount++;
    lumine.workspace.addOpener((filePath) => {
      if (
        filePath === "lumine://fictitious" ||
        filePath.startsWith("fictitious-prefix://") ||
        /\.(fixed|mixed|configured)$/i.test(filePath)
      ) {
        this.openerCount++;
        const element = document.createElement("div");
        element.dataset.filePath = filePath;
        return element;
      }
    });
  },
};
