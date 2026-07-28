// Branch-name prompt: the query is the proposed name and confirming submits
// it. Exposed as a view spec so callers can push it onto a running session
// rather than opening a second modal on top of the first.
module.exports = function branchNameSpec({ prompt, onConfirm }) {
  return {
    id: "git-center.branch-name",
    template: "input",
    className: "git-center-branch-name-dialog",
    title: "New branch",
    placeholder: "Branch name",
    willOpen: (session) => session.setStatus({ message: prompt, severity: "info" }),
    didChangeQuery: (query, session) => session.clearStatus(),
    actions: [
      {
        name: "confirm",
        label: "Create branch",
        when: "always",
        // The checkout is slow enough to Enter twice; blocking is what the
        // hand-rolled `pending` flag used to approximate.
        busy: "block",
        run: async ({ query, session }) => {
          const name = query.raw.trim();
          if (!name) {
            session.setStatus({ message: "Enter a branch name.", severity: "error" });
            return { keepOpen: true };
          }
          const succeeded = await onConfirm?.(name);
          // A failed checkout leaves the name on screen to be corrected.
          return succeeded ? undefined : { keepOpen: true };
        },
      },
    ],
  };
};
