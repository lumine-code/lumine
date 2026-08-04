// No pragma of any kind: a .jsx file always compiles through Babel, with
// etch.dom as the default JSX factory.

// eslint-disable-next-line no-unused-vars -- referenced by the default JSX factory
const etch = {
  dom(...args) {
    return args;
  },
};

module.exports = <div className="settings-view" />;
