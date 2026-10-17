// Sandboxed Electron preloads use CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("duoDesk", {
  invoke: (command, args) =>
    ipcRenderer.invoke("duodesk:command", command, args),
  subscribe: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("duodesk:event", listener);
    return () => ipcRenderer.removeListener("duodesk:event", listener);
  },
});
