// Branch-name prompt built on InputDialogView: the query is the proposed name
// and confirming submits it.
module.exports = class BranchNameDialog {
  constructor() {
    this.inputDialogView = atom.workspace.buildInputDialog({
      className: "git-center-branch-name-dialog",
      didChangeQuery: () => this.inputDialogView.update({ errorMessage: null }),
      didConfirm: () => this.confirm(),
      didCancel: () => this.hide(),
    });
  }

  // With `crumb`, the dialog displays itself as a step of the modal flow: the
  // modal visible at that moment becomes the previous breadcrumb entry and
  // Shift-Escape returns to it. Without `crumb` it opens standalone.
  show({ prompt, onConfirm, crumb }) {
    this.onConfirm = onConfirm;
    this.pending = false;
    this.inputDialogView.reset();
    this.inputDialogView.update({
      infoMessage: prompt,
      errorMessage: null,
      placeholderText: "Branch name",
    });
    this.inputDialogView.show(crumb ? { crumb } : undefined);
  }

  async confirm() {
    const name = this.inputDialogView.getQuery().trim();
    if (this.pending) return;
    if (!name) {
      await this.inputDialogView.update({ errorMessage: "Enter a branch name." });
      return;
    }

    this.pending = true;
    const succeeded = await this.onConfirm?.(name);
    this.pending = false;
    if (succeeded) this.hide();
  }

  hide() {
    this.inputDialogView.hide();
  }

  destroy() {
    this.inputDialogView.destroy();
  }
};
