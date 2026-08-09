// Error types for Git command failures surfaced to the Git UI packages. They
// live in core and are re-exported from the `lumine` module so that git-panel and
// github-panel share a single class identity: a github-panel
// `catch (e) { if (e instanceof GitError) ... }` must match the error git-panel
// throws, which only holds when both import the same class.
class GitError extends Error {
  constructor(message) {
    super(message);
    this.message = message;
    this.stack = new Error().stack;
  }
}

class LargeRepoError extends Error {
  constructor(message) {
    super(message);
    this.message = message;
    this.stack = new Error().stack;
  }
}

module.exports = { GitError, LargeRepoError };
