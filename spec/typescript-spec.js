const expectedError = new Error("Success!");

describe("TypeScript transpiler support", function () {
  describe("when there is a .ts file", () =>
    it("transpiles it using typescript", function () {
      const transpiled = require("./fixtures/typescript/valid.ts");
      expect(transpiled(3)).toBe(4);
    }));

  describe("when there is a .tsx file", () =>
    it("transpiles it with etch.dom as the default JSX factory", function () {
      const element = require("./fixtures/typescript/jsx.tsx");
      expect(element[0]).toBe("div");
      expect(element[1]).toEqual({ className: "settings-view" });
    }));

  describe("when the .ts file is invalid", () => {
    it("does not transpile", () => {
      expect(() => {
        try {
          require("./fixtures/typescript/invalid.ts");
        } catch (error) {
          if (error.message.includes("Could not compile TypeScript")) {
            throw expectedError;
          }
          throw error;
        }
      }).toThrow(expectedError);
    });
  });
});
