/** @jsx factory.create */
/** @jsxFrag factory.fragment */

const factory = {
  fragment: "custom-fragment",
  create(...args: unknown[]) {
    return ["custom", ...args];
  },
};

const element = <><span className="override" /></>;
export = element;
