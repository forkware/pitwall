// The desktop window. All logic stays in the Node server; this only shows its page.
const { app, BrowserWindow, ipcMain, Menu, nativeTheme, screen, shell } = require("electron");
const { cpSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { fitToDisplays, loadWindowState, trackWindowState } = require("./windowState.cjs");
const { ID, NAME, installDesktopEntry } = require("./desktopEntry.cjs");

// Without a name Electron keeps its profile in the shared "Electron" directory.
app.setName("pitwall");
const profile = join(app.getPath("appData"), "pitwall");
// The window's saved state (theme, open folders, ...) used to live there; take it along once.
const shared = join(app.getPath("appData"), "Electron", "Local Storage");
if (!existsSync(profile) && existsSync(shared)) {
  try {
    cpSync(shared, join(profile, "Local Storage"), { recursive: true });
  } catch (error) {
    console.error("Could not copy the window's saved state:", error);
  }
}
app.setPath("userData", profile);

const icon = join(__dirname, "icons", "icon.png");
if (process.platform === "linux") {
  // The window's Wayland app id; Electron's own is "electron", which the dock shows as the name.
  app.setDesktopName(`${ID}.desktop`);
  try {
    installDesktopEntry(join(__dirname, "..", ".."), icon);
  } catch (error) {
    console.error("Could not add the app to the applications menu:", error);
  }
}

const url = process.env.PITWALL_URL;
const origin = new URL(url).origin;

// macOS dictation, the same as Edit > Start Dictation (or pressing Fn twice), into the focused field.
ipcMain.handle("desktop:start-dictation", () => {
  if (process.platform !== "darwin") return false;
  Menu.sendActionToFirstResponder("startDictation:");
  return true;
});

app.whenReady().then(() => {
  if (process.platform === "darwin") app.dock?.setIcon(icon);
  // Size, position and maximized state as the window was last closed.
  const stateFile = join(app.getPath("userData"), "window-state.json");
  const state = fitToDisplays(
    loadWindowState(stateFile),
    screen.getAllDisplays().map((display) => display.workArea),
  );
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    show: false,
    minWidth: 900,
    minHeight: 560,
    title: NAME,
    icon,
    // The page's background (--bg) for the theme, shown until the page draws.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b0c0f" : "#fafafb",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "preload.cjs"),
    },
  });
  // Links to other sites open in the user's browser, not in the app window.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== origin) {
      event.preventDefault();
      shell.openExternal(target);
    }
  });
  if (state.maximized) win.maximize();
  if (state.fullScreen) win.setFullScreen(true);
  win.show();
  trackWindowState(win, stateFile);
  win.loadURL(url);
});

app.on("window-all-closed", () => app.quit());
