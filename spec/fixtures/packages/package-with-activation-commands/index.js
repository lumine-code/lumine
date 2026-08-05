module.exports = {
  activateCallCount: 0,
  activationCommandCallCount: 0,

  activate() {
    this.activateCallCount++;

    atom.commands.add("atom-workspace", "activation-command", () => {
      this.activationCommandCallCount++;
    });
  },
};
