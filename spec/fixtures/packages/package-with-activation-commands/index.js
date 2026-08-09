module.exports = {
  activateCallCount: 0,
  activationCommandCallCount: 0,

  activate() {
    this.activateCallCount++;

    lumine.commands.add("lumine-workspace", "activation-command", () => {
      this.activationCommandCallCount++;
    });
  },
};
