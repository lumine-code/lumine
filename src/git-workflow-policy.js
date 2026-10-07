const { OPERATION_OPTION_INDEX, rawGitCommand } = require("./git-operation-metadata");

function refused(code, message) {
  return Object.assign(new Error(message), { code, outcome: "not-started", retriable: false });
}

module.exports = class GitWorkflowPolicy {
  constructor({ config, confirm }) {
    this.config = config;
    this.confirm = confirm;
  }

  requiresCheck(name, args, workflowOptions = {}) {
    const options = args[OPERATION_OPTION_INDEX[name]] || {};
    const effectiveName = name === "executeGit" ? rawGitCommand(args[0]) : name;
    const force =
      options.force ||
      options.forceWithLease ||
      (name === "executeGit" &&
        args[0]?.some(
          (arg) => ["--force", "-f"].includes(arg) || String(arg).startsWith("--force-with-lease"),
        ));
    return Boolean(
      options.expectedHead ||
      workflowOptions.expectedHead ||
      (effectiveName === "commit" && this.config?.get("git.protectCommits")) ||
      (effectiveName === "push" &&
        (this.config?.get("git.protectPushes") ||
          (force && this.config?.get("git.confirmForcePush")))),
    );
  }

  async assertAllowed(repository, name, args, workflowOptions = {}) {
    const optionIndex = OPERATION_OPTION_INDEX[name];
    const options = args[optionIndex] || {};
    const effectiveName = name === "executeGit" ? rawGitCommand(args[0]) : name;
    const force =
      options.force ||
      options.forceWithLease ||
      (name === "executeGit" &&
        args[0]?.some(
          (arg) => ["--force", "-f"].includes(arg) || String(arg).startsWith("--force-with-lease"),
        ));
    const signal = options.signal || workflowOptions.signal;
    signal?.throwIfAborted();
    const expectedHead = options.expectedHead || workflowOptions.expectedHead;
    const protectedOperation =
      (effectiveName === "commit" && this.config?.get("git.protectCommits")) ||
      (effectiveName === "push" && this.config?.get("git.protectPushes"));
    let checkedHead = null;
    if (protectedOperation || expectedHead) {
      const snapshot = await repository.refreshStatusSnapshot({ priority: "interactive", signal });
      const head = snapshot?.head || repository.getStatusSnapshot?.().head;
      checkedHead = head;
      if (expectedHead && (head?.name !== expectedHead.name || head?.oid !== expectedHead.oid)) {
        throw refused(
          "ERR_GIT_CONTEXT_CHANGED",
          "The repository HEAD changed while this Git action was being prepared.",
        );
      }
      if (
        protectedOperation &&
        (this.config.get("git.protectedBranches") || []).includes(head?.name)
      ) {
        throw refused(
          "ERR_GIT_OPERATION_BLOCKED",
          `Git ${effectiveName} is blocked on protected branch ${head.name}.`,
        );
      }
    }
    if (effectiveName === "push" && force && this.config?.get("git.confirmForcePush")) {
      if (!this.confirm)
        throw refused(
          "ERR_GIT_CONFIRMATION_UNAVAILABLE",
          "Force push requires a confirmation handler.",
        );
      const before = checkedHead
        ? null
        : await repository.refreshStatusSnapshot({ priority: "interactive", signal });
      const confirmedHead = checkedHead || before?.head || repository.getStatusSnapshot?.().head;
      const choice = await this.confirm({
        message: "Confirm Force Push",
        detail: "Replace the remote branch with this repository's branch.",
        buttons: ["Force Push", "Cancel"],
      });
      if (choice !== 0) throw refused("ERR_GIT_OPERATION_CANCELLED", "Force push was cancelled.");
      signal?.throwIfAborted();
      // A confirmation can outlive a branch change. Recheck policy after the
      // dialog, without asking for the same confirmation a second time.
      if (protectedOperation || expectedHead || confirmedHead) {
        const snapshot = await repository.refreshStatusSnapshot({
          priority: "interactive",
          signal,
        });
        const head = snapshot?.head || repository.getStatusSnapshot?.().head;
        if (expectedHead && (head?.name !== expectedHead.name || head?.oid !== expectedHead.oid))
          throw refused(
            "ERR_GIT_CONTEXT_CHANGED",
            "The repository HEAD changed during force-push confirmation.",
          );
        if (
          protectedOperation &&
          (this.config.get("git.protectedBranches") || []).includes(head?.name)
        )
          throw refused(
            "ERR_GIT_OPERATION_BLOCKED",
            `Git ${effectiveName} is blocked on protected branch ${head.name}.`,
          );
        if (confirmedHead && (head?.name !== confirmedHead.name || head?.oid !== confirmedHead.oid))
          throw refused(
            "ERR_GIT_CONTEXT_CHANGED",
            "The repository HEAD changed during force-push confirmation.",
          );
      }
    }
  }
};
