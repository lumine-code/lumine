/** @jsx factory.create */

// A per-file pragma comment overrides the default etch.dom factory.

// eslint-disable-next-line no-unused-vars -- referenced by the JSX pragma
const factory = {
  create(...args) {
    return ["custom", ...args];
  },
};

module.exports = <span className="override" />;
