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
    const result = await window.webContents.executeJavaScript(
      `(async () => {
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
    await wait(()=>document.querySelector('.code-pairing strong'), 'Pairing UI did not appear');
    const code = document.querySelector('.code-pairing strong');
    if (!code || !/^[0-9]{6}$/.test(code.textContent)) throw Error('Pairing code missing');
    const qr = document.querySelector('.code-pairing .qr-frame svg');
    if (!qr) throw Error('Six-digit pairing QR missing');
    if (qr.closest('details')) throw Error('Pairing QR should be directly visible, not inside a collapsed details toggle');
    if (document.querySelector('textarea') || document.body.innerText.includes('Manual invitation')) throw Error('Legacy invitation input returned');
    if (!document.querySelector('video').controls) throw Error('Video controls missing');
    const select = document.querySelector('select');
    if (!select.disabled) throw Error('Address can change during session');
    button('Stop session').click();
    await wait(()=>!document.querySelector('.code-pairing strong') && !select.disabled, 'Stop did not clear pairing UI');
    if (!document.querySelector('[role="status"]').textContent.includes('Session ended')) throw Error('Stopped status missing');
    if (document.querySelector('.app-header, .page-heading, .preview-notice, .diagnostics, footer')) throw Error('Removed UI returned');
    for (const name of ['camera', 'microphone']) {
      const permission = await navigator.permissions.query({name});
      if (permission.state !== 'denied') throw Error(name + ' permission must remain denied');
    }
    button('Fullscreen').click();
    await wait(()=>document.fullscreenElement?.classList.contains('receiver-panel'), 'Fullscreen did not open receiver: ' + document.querySelector('[role=alert]')?.textContent);
    await wait(()=>button('Exit fullscreen'), 'Fullscreen button did not update');
    button('Exit fullscreen').click();
    await wait(()=>!document.fullscreenElement, 'Fullscreen did not exit');
    return {passed:true,addressOptions:select.options.length,pairingQr:true,stopped:true,videoControls:true,fullscreen:true};
  })()`,
      true,
    );
    console.log(JSON.stringify(result));
    clearTimeout(deadline);
    app.quit();
  } catch (error) {
    console.error(error);
    clearTimeout(deadline);
    app.exit(1);
  }
})();
