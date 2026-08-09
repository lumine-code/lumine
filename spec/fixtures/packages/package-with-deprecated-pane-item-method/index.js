class TestItem {
  getUri() {
    return "test";
  }
}

exports.activate = () => {
  lumine.workspace.addOpener(() => new TestItem());
};
