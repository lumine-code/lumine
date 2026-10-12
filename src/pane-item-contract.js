const { allowedLocationsForItem } = require("./pane-item-locations");

class PaneItemOperationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PaneItemOperationError";
    this.code = code;
  }
}

function assertCenterItemContract(item, location = "center") {
  if (location !== "center") return;
  if (!item || typeof item !== "object") {
    throw new PaneItemOperationError("INVALID_ITEM", "A pane item must be an object.");
  }
}

function assertItemLocation(item, location) {
  if (!allowedLocationsForItem(item).includes(location)) {
    throw new PaneItemOperationError(
      "ITEM_LOCATION",
      `This item cannot be displayed in the ${location} pane container.`,
    );
  }
  assertCenterItemContract(item, location);
}

module.exports = { PaneItemOperationError, assertCenterItemContract, assertItemLocation };
