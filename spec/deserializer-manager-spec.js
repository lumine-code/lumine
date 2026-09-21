const DeserializerManager = require("../src/deserializer-manager");

describe("DeserializerManager", function () {
  let manager = null;

  class Foo {
    static deserialize({ name }) {
      return new Foo(name);
    }
    constructor(name) {
      this.name = name;
    }
  }

  beforeEach(() => (manager = new DeserializerManager()));

  describe("::add(deserializer)", () =>
    it("returns a disposable that can be used to remove the manager", function () {
      const disposable = manager.add(Foo);
      expect(manager.deserialize({ deserializer: "Foo", name: "Bar" })).toBeDefined();
      disposable.dispose();
      spyOn(console, "warn");
      expect(manager.deserialize({ deserializer: "Foo", name: "Bar" })).toBeUndefined();
    }));

  it("keeps the newest owner when an older registration is disposed", () => {
    const oldDeserializer = {
      name: "Shared",
      deserialize: () => "old",
    };
    const newDeserializer = {
      name: "Shared",
      deserialize: () => "new",
    };
    const oldRegistration = manager.add(oldDeserializer);
    const newRegistration = manager.add(newDeserializer);

    oldRegistration.dispose();
    expect(manager.deserialize({ deserializer: "Shared" })).toBe("new");

    newRegistration.dispose();
    spyOn(console, "warn");
    expect(manager.deserialize({ deserializer: "Shared" })).toBeUndefined();
  });

  it("restores the previous owner when the newest registration is disposed", () => {
    const oldDeserializer = {
      name: "Shared",
      deserialize: () => "old",
    };
    const newDeserializer = {
      name: "Shared",
      deserialize: () => "new",
    };
    manager.add(oldDeserializer);
    const newRegistration = manager.add(newDeserializer);

    newRegistration.dispose();

    expect(manager.deserialize({ deserializer: "Shared" })).toBe("old");
  });

  describe("::deserialize(state)", function () {
    beforeEach(() => manager.add(Foo));

    it("calls deserialize on the manager for the given state object, or returns undefined if one can't be found", function () {
      spyOn(console, "warn");
      const object = manager.deserialize({ deserializer: "Foo", name: "Bar" });
      expect(object.name).toBe("Bar");
      expect(manager.deserialize({ deserializer: "Bogus" })).toBeUndefined();
    });

    describe("when the manager has a version", function () {
      beforeEach(() => (Foo.version = 2));

      describe("when the deserialized state has a matching version", () =>
        it("attempts to deserialize the state", function () {
          const object = manager.deserialize({
            deserializer: "Foo",
            version: 2,
            name: "Bar",
          });
          expect(object.name).toBe("Bar");
        }));

      describe("when the deserialized state has a non-matching version", () =>
        it("returns undefined", function () {
          expect(
            manager.deserialize({
              deserializer: "Foo",
              version: 3,
              name: "Bar",
            }),
          ).toBeUndefined();
          expect(
            manager.deserialize({
              deserializer: "Foo",
              version: 1,
              name: "Bar",
            }),
          ).toBeUndefined();
          expect(manager.deserialize({ deserializer: "Foo", name: "Bar" })).toBeUndefined();
        }));
    });
  });
});
