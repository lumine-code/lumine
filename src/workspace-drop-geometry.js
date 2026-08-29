const SPLITS = new Set(["left", "right", "up", "down"]);

function splitForPoint(rect, x, y) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const relativeX = (x - rect.left) / rect.width;
  const relativeY = (y - rect.top) / rect.height;
  if (relativeX < 1 / 3) return "left";
  if (relativeX > 2 / 3) return "right";
  if (relativeY < 1 / 3) return "up";
  if (relativeY > 2 / 3) return "down";
  return null;
}

function boundsForSplit(rect, split) {
  const bounds = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  switch (split) {
    case "left":
      bounds.width /= 2;
      break;
    case "right":
      bounds.left += bounds.width / 2;
      bounds.width /= 2;
      break;
    case "up":
      bounds.height /= 2;
      break;
    case "down":
      bounds.top += bounds.height / 2;
      bounds.height /= 2;
      break;
  }
  return bounds;
}

module.exports = { SPLITS, splitForPoint, boundsForSplit };
