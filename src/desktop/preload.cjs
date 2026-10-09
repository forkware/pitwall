// What the desktop window offers the page beyond a browser: window.pitwallDesktop. Only OS services; no logic.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pitwallDesktop", {
  /** "darwin", "linux", "win32". */
  platform: process.platform,
  /** Starts the system's dictation into the focused field; resolves to false where the system has none to start. */
  startDictation: () => ipcRenderer.invoke("desktop:start-dictation"),
});
