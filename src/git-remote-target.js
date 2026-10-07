function parts(target, remotes) {
  if (target?.ref?.startsWith("refs/heads/"))
    return { remote: ".", reference: target.ref.slice(11) };
  const name = target?.ref?.startsWith("refs/remotes/") ? target.ref.slice(13) : target?.name || "";
  const remote = remotes
    .map((entry) => entry.name)
    .filter((candidate) => name.startsWith(`${candidate}/`))
    .sort((left, right) => right.length - left.length)[0];
  return remote ? { remote, reference: name.slice(remote.length + 1) } : null;
}

module.exports = function resolveRemoteTarget(refs, operation) {
  const branch = refs.branches.find((entry) => entry.isHead);
  if (!branch)
    throw Object.assign(new Error(`Git ${operation} requires an active local branch.`), {
      code: "ERR_GIT_REMOTE_CONTEXT",
    });
  const upstream = parts(branch.upstream, refs.remotes);
  const push = parts(branch.push, refs.remotes);
  const target =
    operation === "pull" ? upstream : operation === "push" ? push || upstream : upstream || push;
  const fallback =
    refs.remotes.length === 1
      ? refs.remotes[0].name
      : refs.remotes.find((entry) => entry.name === "origin")?.name;
  const remote = target?.remote || (operation === "pull" ? null : fallback);
  if (!remote)
    throw Object.assign(
      new Error(
        operation === "pull"
          ? "The current branch has no upstream to pull from."
          : `The current branch does not identify a remote to ${operation}.`,
      ),
      { code: "ERR_GIT_REMOTE_CONTEXT" },
    );
  const reference =
    operation === "fetch"
      ? null
      : operation === "pull"
        ? target.reference
        : target && target.reference !== branch.name
          ? `${branch.name}:${target.reference}`
          : branch.name;
  return Object.freeze({ remote, reference, setUpstream: operation === "push" && !target });
};
