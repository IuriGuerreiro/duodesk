// Exercise the shipped renderer controls against the real Electron host.
import { app, BrowserWindow } from "electron";
import "../electron/main.mjs";
const deadline = setTimeout(() => app.exit(1), 30000);
void (async () => {
  try {
    await app.whenReady();
    let window;
    for (let i = 0; i < 100; i++) {
      window = BrowserWindow.getAllWindows()[0];
      if (
        window &&
        !window.webContents.isLoading() &&
        window.webContents.getURL().startsWith("duodesk://app/")
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = async (predicate, message) => {
      for (let i=0;i<100;i++) { if(predicate()) return; await new Promise(r=>setTimeout(r,50)); }
      throw Error(message);
    };
    const button = text => [...document.querySelectorAll('button')].find(b=>b.textContent.includes(text));
    await wait(()=>[...document.querySelector('select')?.options ?? []].some(o=>o.value && !o.disabled), 'Address discovery failed');
    const choose = document.querySelector('select');
    if (choose.value || !button('Create connection').disabled) throw Error('Address must be selected explicitly');
    choose.value = [...choose.options].find(o=>o.value && !o.disabled).value;
    choose.dispatchEvent(new Event('change', {bubbles:true}));
    await wait(()=>!button('Create connection').disabled, 'Address selection failed');
    button('Create connection').click();
    await wait(()=>document.querySelector('[aria-label="Manual invitation"]'), 'Pairing UI did not appear');
    const invitation = JSON.parse(document.querySelector('[aria-label="Manual invitation"]').value);
    if (!invitation.url.startsWith('wss://') || invitation.fingerprint.length !== 64) throw Error('Invalid real invitation');
    const code = document.querySelector('.code-pairing strong');
    if (!code || !/^[0-9]{6}$/.test(code.textContent)) throw Error('Pairing code missing');
    if (document.querySelector('.qr-details').open || document.querySelector('.manual-details').open) throw Error('Pairing alternatives should start collapsed');
    if (!document.querySelector('video').controls) throw Error('Video controls missing');
    const select = document.querySelector('select');
    if (!select.disabled) throw Error('Address can change during session');
    button('Stop session').click();
    await wait(()=>!document.querySelector('[aria-label="Manual invitation"]') && !select.disabled, 'Stop did not clear pairing UI');
    document.querySelector('.diagnostics').open = true;
    if (!document.querySelector('.diagnostic-grid').textContent.includes('Session ended')) throw Error('Diagnostics missed stopped state');
    return {passed:true,addressOptions:select.options.length,stopped:true,videoControls:true};
  })()`);
    console.log(JSON.stringify(result));
    clearTimeout(deadline);
    app.quit();
  } catch (error) {
    console.error(error);
    clearTimeout(deadline);
    app.exit(1);
  }
})();
