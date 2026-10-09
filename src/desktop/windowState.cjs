// The window's size, position and maximized/fullscreen state, kept between launches.
const { readFileSync, writeFileSync, renameSync } = require("node:fs");

const DEFAULTS = { width: 1440, height: 900 };

/** The saved state, or the defaults when there is none or it is broken. */
function loadWindowState(file) {
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    const state = { ...DEFAULTS };
    for (const key of ["x", "y", "width", "height"]) {
      if (Number.isFinite(saved[key])) state[key] = Math.round(saved[key]);
    }
    state.maximized = saved.maximized === true;
    state.fullScreen = saved.fullScreen === true;
    return state;
  } catch {
    return { ...DEFAULTS, maximized: false, fullScreen: false };
  }
}

function saveWindowState(file, state) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, file);
}

/**
 * Keeps the position only when the window would be visible on one of the displays' work areas
 * (a monitor may be gone since), else lets the window manager center it. Size is capped to the work area.
 */
function fitToDisplays(state, workAreas) {
  const result = { ...state };
  const overlaps = (a) =>
    result.x !== undefined &&
    result.y !== undefined &&
    result.x < a.x + a.width - 50 &&
    result.x + result.width > a.x + 50 &&
    result.y >= a.y - 10 &&
    result.y < a.y + a.height - 50;
  const area = workAreas.find(overlaps);
  if (!area) {
    delete result.x;
    delete result.y;
  }
  const bounds = area ?? workAreas[0];
  if (bounds) {
    result.width = Math.min(result.width, bounds.width);
    result.height = Math.min(result.height, bounds.height);
  }
  return result;
}

/** Saves the window's state whenever it changes (debounced) and when it closes. */
function trackWindowState(win, file) {
  let timer;
  const save = () => {
    clearTimeout(timer);
    if (win.isDestroyed()) return;
    const maximized = win.isMaximized();
    const fullScreen = win.isFullScreen();
    // While maximized or fullscreen keep the normal bounds, so un-maximizing after a restart lands where it was.
    const bounds = maximized || fullScreen || win.isMinimized() ? win.getNormalBounds() : win.getBounds();
    try {
      saveWindowState(file, { ...bounds, maximized, fullScreen });
    } catch (error) {
      console.error("Could not save the window's state:", error);
    }
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  for (const event of ["resize", "move", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) {
    win.on(event, later);
  }
  win.on("close", save);
}

module.exports = { loadWindowState, saveWindowState, fitToDisplays, trackWindowState, DEFAULTS };
