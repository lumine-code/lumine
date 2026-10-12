module.exports = {
  "window:focus-pane-up": {
    description: "Focus the nearest visible pane above, including docks.",
    direction: "up",
    action: "focus",
  },
  "window:focus-pane-down": {
    description: "Focus the nearest visible pane below, including docks.",
    direction: "down",
    action: "focus",
  },
  "window:focus-pane-left": {
    description: "Focus the nearest visible pane on the left, including docks.",
    direction: "left",
    action: "focus",
  },
  "window:focus-pane-right": {
    description: "Focus the nearest visible pane on the right, including docks.",
    direction: "right",
    action: "focus",
  },
  "pane:move-active-item-up": {
    description: "Move the active tab to the nearest allowed pane above.",
    direction: "up",
    action: "move",
  },
  "pane:move-active-item-down": {
    description: "Move the active tab to the nearest allowed pane below.",
    direction: "down",
    action: "move",
  },
  "pane:move-active-item-left": {
    description: "Move the active tab to the nearest allowed pane on the left.",
    direction: "left",
    action: "move",
  },
  "pane:move-active-item-right": {
    description: "Move the active tab to the nearest allowed pane on the right.",
    direction: "right",
    action: "move",
  },
  "pane:copy-active-item-up": {
    description: "Copy the active tab to the nearest allowed pane above.",
    direction: "up",
    action: "copy",
  },
  "pane:copy-active-item-down": {
    description: "Copy the active tab to the nearest allowed pane below.",
    direction: "down",
    action: "copy",
  },
  "pane:copy-active-item-left": {
    description: "Copy the active tab to the nearest allowed pane on the left.",
    direction: "left",
    action: "copy",
  },
  "pane:copy-active-item-right": {
    description: "Copy the active tab to the nearest allowed pane on the right.",
    direction: "right",
    action: "copy",
  },
  "pane:split-up-and-move-active-item": { direction: "up", action: "move", split: true },
  "pane:split-down-and-move-active-item": { direction: "down", action: "move", split: true },
  "pane:split-left-and-move-active-item": { direction: "left", action: "move", split: true },
  "pane:split-right-and-move-active-item": { direction: "right", action: "move", split: true },
  "pane:split-up-and-copy-active-item": { direction: "up", action: "copy", split: true },
  "pane:split-down-and-copy-active-item": { direction: "down", action: "copy", split: true },
  "pane:split-left-and-copy-active-item": { direction: "left", action: "copy", split: true },
  "pane:split-right-and-copy-active-item": { direction: "right", action: "copy", split: true },
};
