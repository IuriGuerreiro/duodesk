// Run alongside Vite, like receiver-smoke.mjs.
import { app, BrowserWindow } from "electron";
const deadline = setTimeout(() => app.exit(1), 30000);
app.whenReady().then(async () => {
  try {
    const window = new BrowserWindow({
      show: true,
      webPreferences: { backgroundThrottling: false },
    });
    await window.loadURL("http://127.0.0.1:1422/test/control-surface.html");
    const result = await window.webContents.executeJavaScript(
      "window.runControlSurface()",
    );
    console.log(JSON.stringify(result));
    clearTimeout(deadline);
    app.exit(result.passed ? 0 : 1);
  } catch (error) {
    console.error(error);
    clearTimeout(deadline);
    app.exit(1);
  }
});
