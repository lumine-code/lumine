// No pragma: a .tsx file compiles with etch.dom as the default JSX factory.

const etch = {
  dom(...args: unknown[]) {
    return args;
  },
};

const element = <div className="settings-view" />;
export = element;
