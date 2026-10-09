// The app's name and icon on the Linux desktop. GNOME and KDE take both from a .desktop file whose name
// matches the window's app id (Wayland) or WM_CLASS (X11); without one the dock shows "electron" and a gear.
const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const ID = "pitwall";
const NAME = "Pitwall";

/** The .desktop file's text: the launcher runs `run.sh` of the checkout at `root`. */
function desktopEntry(root, icon) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${NAME}`,
    "Comment=Manager for AI coding agents",
    `Exec="${join(root, "run.sh")}"`,
    `Icon=${icon}`,
    "Terminal=false",
    "Categories=Development;",
    `StartupWMClass=${ID}`,
    "",
  ].join("\n");
}

/** The checkout's `run.sh` an entry launches, if it names one. */
function launchedScript(text) {
  const match = /^Exec="?([^"\n]+)"?$/m.exec(text);
  return match ? match[1] : undefined;
}

/**
 * Writes `<applications>/pitwall.desktop` for the checkout at `root`. An entry of another checkout
 * that still exists stays: the app also runs from task worktrees, which come and go.
 */
function installDesktopEntry(root, icon, applications = defaultApplicationsDir()) {
  const file = join(applications, `${ID}.desktop`);
  const text = desktopEntry(root, icon);
  let current;
  try {
    current = readFileSync(file, "utf8");
  } catch {}
  if (current === text) return false;
  const script = current && launchedScript(current);
  if (script && script !== join(root, "run.sh") && existsSync(script)) return false;
  mkdirSync(applications, { recursive: true });
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
  return true;
}

function defaultApplicationsDir() {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "applications");
}

module.exports = { ID, NAME, desktopEntry, installDesktopEntry };
