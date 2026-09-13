const {
  defaultLocationForItem,
  allowedLocationsForItem,
  isItemAllowedInLocation,
} = require("../src/pane-item-locations");

describe("pane item locations", () => {
  it("keeps an item without location hooks in the workspace center", () => {
    const item = {};

    expect(defaultLocationForItem(item)).toBe("center");
    expect(allowedLocationsForItem(item)).toEqual(["center"]);
    expect(isItemAllowedInLocation(item, "center")).toBe(true);
    expect(isItemAllowedInLocation(item, "bottom")).toBe(false);
  });

  it("uses the declared default as the only implicit allowed location", () => {
    const item = { getDefaultLocation: () => "right" };

    expect(defaultLocationForItem(item)).toBe("right");
    expect(allowedLocationsForItem(item)).toEqual(["right"]);
    expect(isItemAllowedInLocation(item, "right")).toBe(true);
    expect(isItemAllowedInLocation(item, "left")).toBe(false);
  });

  it("preserves an explicit list of allowed locations", () => {
    const item = {
      getDefaultLocation: () => "right",
      getAllowedLocations: () => ["right", "left"],
    };

    expect(allowedLocationsForItem(item)).toEqual(["right", "left"]);
    expect(isItemAllowedInLocation(item, "left")).toBe(true);
    expect(isItemAllowedInLocation(item, "bottom")).toBe(false);
  });
});
