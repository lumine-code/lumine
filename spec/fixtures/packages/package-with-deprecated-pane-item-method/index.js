class TestItem {
  getUri() {
    return "test";
  }
}

exports.activate = () => {
  atom.workspace.addOpener(() => new TestItem());
};
