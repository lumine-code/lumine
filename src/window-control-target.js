"use strict";

// Window chrome remains usable while a document modal owns focus. Providers
// mark only their native window actions, so ordinary title-bar tiles still
// follow the modal's normal outside-click policy.
function isWindowControlTarget(target) {
  return Boolean(target?.closest?.("[data-window-control]"));
}

module.exports = { isWindowControlTarget };
