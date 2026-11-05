const MINIMUM_ZOOM_FACTOR = 0.25;
const MAXIMUM_ZOOM_FACTOR = 5;
const ZOOM_FACTOR_STEP = 0.05;

function normalizeZoomFactor(factor) {
  return Number.isFinite(factor)
    ? Math.max(MINIMUM_ZOOM_FACTOR, Math.min(MAXIMUM_ZOOM_FACTOR, Math.round(factor * 1e12) / 1e12))
    : 1;
}

function getDefaultZoomFactor(lumineWindow) {
  // Spec renderers deliberately omit user settings. Their native presentation
  // must start from the same defaults instead of inheriting the real profile.
  return lumineWindow.isSpec
    ? 1
    : normalizeZoomFactor(lumineWindow.lumineApplication.config.get("core.zoomFactor"));
}

// Page zoom remains available through commands. Pinch zoom is a separate
// Chromium scale and must not introduce another, untracked zoom layer.
function disableVisualZoom(webContents) {
  if (webContents.isDestroyed?.()) return Promise.resolve();
  const frame = webContents.mainFrame;
  if (frame?.isDestroyed()) return Promise.resolve();
  return Promise.resolve(webContents.setVisualZoomLevelLimits(1, 1)).catch((error) => {
    // A frame can be disposed before its WebContents finishes closing or reloads.
    if (webContents.isDestroyed?.() || frame?.isDestroyed()) return;
    throw error;
  });
}

function getZoomFactor(webContents) {
  return normalizeZoomFactor(webContents.getZoomFactor());
}

function getZoomState(lumineWindow, webContents) {
  return {
    factor: getZoomFactor(webContents),
    defaultFactor: getDefaultZoomFactor(lumineWindow),
  };
}

function setZoomFactor(webContents, factor) {
  const previousFactor = getZoomFactor(webContents);
  webContents.setZoomFactor(normalizeZoomFactor(factor));
  const currentFactor = getZoomFactor(webContents);
  if (currentFactor !== previousFactor) {
    webContents.emit("lumine-did-change-zoom-factor", currentFactor);
  }
  return currentFactor;
}

function changeZoomFactor(webContents, delta) {
  return setZoomFactor(webContents, getZoomFactor(webContents) + delta);
}

function zoomIn(webContents) {
  return changeZoomFactor(webContents, ZOOM_FACTOR_STEP);
}

function zoomOut(webContents) {
  return changeZoomFactor(webContents, -ZOOM_FACTOR_STEP);
}

function resetZoom(webContents, defaultFactor) {
  return setZoomFactor(webContents, defaultFactor);
}

module.exports = {
  disableVisualZoom,
  getDefaultZoomFactor,
  getZoomFactor,
  getZoomState,
  setZoomFactor,
  zoomIn,
  zoomOut,
  resetZoom,
};
