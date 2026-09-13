const DEFAULT_LOCATION = "center";

function defaultLocationForItem(item) {
  if (typeof item?.getDefaultLocation === "function") {
    return item.getDefaultLocation() || DEFAULT_LOCATION;
  }
  return DEFAULT_LOCATION;
}

function allowedLocationsForItem(item) {
  if (typeof item?.getAllowedLocations === "function") {
    return item.getAllowedLocations();
  }
  return [defaultLocationForItem(item)];
}

function isItemAllowedInLocation(item, location) {
  return allowedLocationsForItem(item).includes(location);
}

module.exports = {
  DEFAULT_LOCATION,
  defaultLocationForItem,
  allowedLocationsForItem,
  isItemAllowedInLocation,
};
